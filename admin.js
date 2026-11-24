'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');

// Upload do PDF da nota fiscal (em memoria; vai para o banco). Só PDF, até 10 MB.
const uploadNf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});
const { exigeAdmin, exigeAdminFull } = require('../auth');
const { enviarEtiquetas } = require('../etiquetas');
const financeiro = require('../financeiro');
const estoque = require('../estoque');
const repasses = require('../repasses');
const novidades = require('../novidades');

// Tela de repasses (Representantes / Funcionarios): seletor, cards, abas e tabela por pedido.
async function telaRepasses(tipo, req, res, next) {
  try {
    const lista = await repasses.pessoas(tipo);
    const param = tipo === 'funcionario' ? 'func' : 'rep';
    let usuarioId = pInt(req.query[param]);
    if (!usuarioId && lista.length) usuarioId = (lista.find((x) => x.ativo) || lista[0]).id;
    const pessoa = lista.find((x) => x.id === usuarioId) || null;
    const sit = ['todos', 'pendente', 'liberado', 'pago'].includes(req.query.sit) ? req.query.sit : 'todos';
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : '';
    const todos = pessoa ? await repasses.listar(tipo, pessoa.id) : [];
    const doMes = mes ? todos.filter((r) => r.aceite_ym === mes) : todos;
    const contagem = { pendente: 0, liberado: 0, pago: 0 };
    doMes.forEach((r) => { contagem[r.situacao]++; });
    res.render('admin/repasses', {
      tipo, param, ativo: tipo === 'funcionario' ? 'funcs' : 'reps',
      titulo: tipo === 'funcionario' ? 'Funcionários' : 'Representantes',
      pessoas: lista, pessoa, linhas: repasses.filtrar(doMes, sit), resumo: repasses.resumo(todos), contagem,
      meses: repasses.mesesDe(todos),
      filtro: { usuarioId, sit, mes }, formas: repasses.FORMAS, hoje: hojeISO(),
      abrirCadastro: req.query.cadastro === '1',
      ok: req.query.ok || null, erro: req.query.erro || null, formatBRL, formatPercent, formatDateTime,
    });
  } catch (e) { next(e); }
}
function voltarRepasses(tipo, req, extra) {
  const q = new URLSearchParams();
  const b = req.body || {};
  const param = tipo === 'funcionario' ? 'func' : 'rep';
  if (b.ret_usuario) q.set(param, b.ret_usuario);
  if (b.ret_sit) q.set('sit', b.ret_sit);
  if (b.ret_mes) q.set('mes', b.ret_mes);
  Object.keys(extra || {}).forEach((k) => q.set(k, extra[k]));
  const s = q.toString();
  return '/admin/' + (tipo === 'funcionario' ? 'funcionarios' : 'representantes') + (s ? '?' + s : '');
}
const {
  formatBRL, formatDateTime, formatPercent, comissaoCentavos, andamentoDisplay,
  horasRestantes, etiquetasExpiradas, parsePrecoToCentavos, parsePercentToBps, precoEfetivo, brDate, hojeISO, skuCor,
  precoSugerido, lucroCom, montarMensagemAcesso,
} = require('../util');

// Calculo de preco sugerido e taxas: modulo compartilhado com a area do cliente.
const { refCustos, comCustos, catalogoDoCliente, garantirItem } = require('../precos');
const imagens = require('../imagens');
const config = require('../config');
const { gerarComprovanteRetirada, montarDados } = require('../comprovante-retirada');
const { gerarExtratoPreposto } = require('../extrato-preposto');

const router = express.Router();
router.use(exigeAdmin);
// Areas com valores de custo/lucro/comissao e acoes sensiveis: so o admin completo.
router.use(['/representantes', '/funcionarios', '/repasses', '/administradores'], exigeAdminFull);
router.post(['/produtos/:id/custos', '/pedido/:id/comissao', '/pedido/:id/funcionario', '/pedido/:id/excluir', '/clientes/:id/excluir'], exigeAdminFull);

// ===================== ONLINE AGORA =====================
// Online = visto nos ultimos 5 minutos. "Hoje" = visto hoje (Sao Paulo).
const ROTULO_PAGINA = [
  [/^\/novo/, 'Novo envio'], [/^\/meus-envios/, 'Meus envios'], [/^\/financeiro/, 'Financeiro'], [/^\/estoque/, 'Estoque'],
  [/^\/admin\/pedidos/, 'Pedidos recebidos'], [/^\/admin\/pedido\//, 'Pedido'], [/^\/admin\/bipagem/, 'Bipagem'], [/^\/admin\/financeiro/, 'Financeiro'],
  [/^\/admin\/clientes/, 'Clientes'], [/^\/admin\/produtos/, 'Produtos'], [/^\/admin\/estoque/, 'Estoque'], [/^\/admin\/precos/, 'Preços por cliente'],
  [/^\/admin\/representantes/, 'Representantes'], [/^\/admin\/funcionarios/, 'Funcionários'], [/^\/admin\/administradores/, 'Administradores'],
  [/^\/rep\//, 'Meus pedidos'], [/^\/func\//, 'Pedidos e taxas'], [/^\/pedido\//, 'Documentos do pedido'],
];
function rotuloPagina(p) { if (!p) return '—'; for (const [re, r] of ROTULO_PAGINA) { if (re.test(p)) return r; } return p; }
async function dadosOnline() {
  const r = await db.query(
    `SELECT u.id, u.nome, u.login, u.papel, u.ultima_pagina, u.visto_em, c.nome AS cliente_nome,
            EXTRACT(EPOCH FROM (now() - u.visto_em))::int AS seg,
            (u.visto_em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS hoje
     FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id
     WHERE u.visto_em IS NOT NULL ORDER BY u.visto_em DESC LIMIT 200`
  );
  const lista = r.rows.map((x) => ({
    id: x.id, nome: x.nome, login: x.login, papel: x.papel, cliente: x.cliente_nome || null,
    pagina: rotuloPagina(x.ultima_pagina), seg: x.seg, online: x.seg <= 300, hoje: !!x.hoje,
    ha: x.seg < 60 ? 'agora' : (x.seg < 3600 ? Math.floor(x.seg / 60) + ' min' : (x.seg < 86400 ? Math.floor(x.seg / 3600) + ' h' : Math.floor(x.seg / 86400) + ' d')),
    visto: formatDateTime(x.visto_em),
  }));
  return { lista, online: lista.filter((x) => x.online).length, hoje: lista.filter((x) => x.hoje).length,
    porPapel: ['cliente', 'admin', 'operador', 'representante', 'funcionario'].map((p) => ({ papel: p, n: lista.filter((x) => x.online && x.papel === p).length })) };
}
router.get('/online', async (req, res, next) => {
  try { res.render('admin/online', { ativo: 'online', dados: await dadosOnline() }); } catch (e) { next(e); }
});
router.get('/online.json', async (req, res) => {
  try { res.json(Object.assign({ ok: true }, await dadosOnline())); } catch (e) { res.status(500).json({ ok: false }); }
});

// ===================== ADMINISTRADORES =====================
router.get('/administradores', async (req, res, next) => {
  try {
    const r = await db.query("SELECT id, nome, login, papel, ativo, criado_em FROM usuarios WHERE papel IN ('admin','operador') ORDER BY papel, nome");
    res.render('admin/administradores', { contas: r.rows, ativo: 'admins', ok: req.query.ok || null, erro: req.query.erro || null, formatDateTime });
  } catch (e) { next(e); }
});
router.post('/administradores', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim(), login = (req.body.login || '').trim(), senha = req.body.senha || '';
    const papel = req.body.papel === 'admin' ? 'admin' : 'operador';
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    if (senha.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
    const adm = await db.query("SELECT senha_hash FROM usuarios WHERE id = $1 AND papel = 'admin'", [req.session.user.id]);
    if (adm.rowCount === 0 || !(await bcrypt.compare(req.body.minha_senha || '', adm.rows[0].senha_hash))) throw new Error('Sua senha de administrador não confere.');
    await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel) VALUES ($1,$2,$3,$4)', [nome, login, await bcrypt.hash(senha, 10), papel]);
    res.redirect('/admin/administradores?ok=' + encodeURIComponent('Conta "' + login + '" criada como ' + (papel === 'admin' ? 'administrador completo' : 'administrador operacional') + '.'));
  } catch (e) { res.redirect('/admin/administradores?erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/administradores/:id/toggle', async (req, res, next) => {
  try {
    const id = pInt(req.params.id);
    if (id === req.session.user.id) return res.redirect('/admin/administradores?erro=' + encodeURIComponent('Você não pode desativar a própria conta.'));
    await db.query("UPDATE usuarios SET ativo = NOT ativo WHERE id = $1 AND papel IN ('admin','operador')", [id]);
    res.redirect('/admin/administradores');
  } catch (e) { next(e); }
});
router.post('/administradores/:id/senha', async (req, res, next) => {
  try {
    const nova = req.body.senha || '';
    if (nova.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
    const adm = await db.query("SELECT senha_hash FROM usuarios WHERE id = $1 AND papel = 'admin'", [req.session.user.id]);
    if (adm.rowCount === 0 || !(await bcrypt.compare(req.body.minha_senha || '', adm.rows[0].senha_hash))) throw new Error('Sua senha de administrador não confere.');
    await db.query("UPDATE usuarios SET senha_hash = $2 WHERE id = $1 AND papel IN ('admin','operador')", [pInt(req.params.id), await bcrypt.hash(nova, 10)]);
    res.redirect('/admin/administradores?ok=' + encodeURIComponent('Senha redefinida.'));
  } catch (e) { res.redirect('/admin/administradores?erro=' + encodeURIComponent(msgErro(e))); }
});

function pInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
// Formularios enviados por fetch (X-Requested-With: fetch) recebem JSON; os demais, redirect como antes.
function isAjax(req) { return req.get('X-Requested-With') === 'fetch'; }
function responder(req, res, payload, redirectUrl) { if (isAjax(req)) return res.json(Object.assign({ ok: true }, payload || {})); res.redirect(redirectUrl); }
function responderErro(req, res, e, base) { const m = msgErro(e); if (isAjax(req)) return res.status(400).json({ ok: false, erro: m }); res.redirect(base + (base.indexOf('?') >= 0 ? '&' : '?') + 'erro=' + encodeURIComponent(m)); }
function msgErro(e) { if (e && e.code === '23505') return 'Login já em uso. Escolha outro.'; return (e && e.message) ? e.message : 'Falha ao salvar.'; }
function naoEncontrado(res, req) { return res.status(404).render('erro', { titulo: 'Não encontrado', mensagem: 'Registro inexistente.', user: req.session.user }); }
function enviarPdf(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buffer);
}
async function funcRef() {
  const r = await db.query("SELECT id, nome, taxa_etiqueta_centavos FROM usuarios WHERE papel = 'funcionario' AND ativo = TRUE AND taxa_etiqueta_centavos IS NOT NULL ORDER BY id");
  return r.rowCount === 1 ? r.rows[0] : null;
}

// ===================== PEDIDOS =====================
router.get('/pedidos', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas, p.tipo,
              p.aceite_em, p.etiquetas_expira_em, p.despachado_em,
              p.comissao_centavos, p.comissao_resp_centavos, p.funcionario_id, p.taxa_func_centavos AS taxa_func_assinada,
              p.imposto_centavos, p.com_nf,
              EXISTS (SELECT 1 FROM notas_fiscais nf WHERE nf.pedido_id = p.id) AS tem_nf,
              (SELECT COALESCE(SUM(custo_centavos * quantidade), 0) FROM linhas WHERE pedido_id = p.id) AS custo_total,
              (SELECT COALESCE(SUM((preco_centavos - COALESCE(preco_base_centavos, preco_centavos)) * quantidade), 0) FROM linhas WHERE pedido_id = p.id) AS adicional_total,
              c.nome AS cliente_nome, u.nome AS rep_nome, ur.nome AS resp_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios u ON u.id = p.representante_id
       LEFT JOIN usuarios ur ON ur.id = p.responsavel_id ORDER BY p.id DESC`
    );
    const fr = await funcRef();
    const pedidos = r.rows.map((p) => {
      // Lucro do pedido = valor - comissao (rep + preposto) - taxa do funcionario atribuido - custo CONGELADO dos itens.
      const comissao = (Number(p.comissao_centavos) || 0) + (Number(p.comissao_resp_centavos) || 0);
      const funcCusto = p.funcionario_id ? (Number(p.taxa_func_assinada) || 0) * p.total_etiquetas : 0;
      const custoTotal = Number(p.custo_total) || 0;
      // O imposto da NF e o acrescimo do preposto (venda acima do sistema) sao repasse, nao lucro:
      // saem do valor antes de calcular o lucro e a margem. O lucro fica sobre o preco de SISTEMA.
      const imposto = Number(p.imposto_centavos) || 0;
      const adicional = Number(p.adicional_total) || 0;
      const base = Number(p.total_centavos) - imposto - adicional;
      const lucro = base - comissao - funcCusto - custoTotal;
      const margem = base > 0 ? Math.round((lucro * 1000) / base) / 10 : 0;
      return {
        ...p, expirado: etiquetasExpiradas(p.etiquetas_expira_em), horas: horasRestantes(p.etiquetas_expira_em),
        taxa_func_centavos: fr ? fr.taxa_etiqueta_centavos * p.total_etiquetas : null,
        lucro_centavos: lucro, margem_pct: margem,
      };
    });
    res.render('admin/pedidos', { pedidos, funcRef: fr, ok: req.query.ok || null, formatBRL, formatDateTime });
  } catch (e) { next(e); }
});

router.get('/pedido/:id', async (req, res, next) => {
  try {
    const pr = await db.query(
      `SELECT p.*, c.nome AS cliente_nome, c.email AS cliente_email, u.nome AS rep_nome, ur.nome AS resp_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios u ON u.id = p.representante_id
       LEFT JOIN usuarios ur ON ur.id = p.responsavel_id WHERE p.id = $1`, [req.params.id]
    );
    if (pr.rowCount === 0) return naoEncontrado(res, req);
    const pedido = pr.rows[0];
    const linhas = await db.query('SELECT * FROM linhas WHERE pedido_id = $1 ORDER BY id', [pedido.id]);
    const reps = await db.query("SELECT id, nome, comissao_bps FROM usuarios WHERE papel = 'representante' AND ativo = TRUE ORDER BY nome");
    const funcs = await db.query("SELECT id, nome, taxa_etiqueta_centavos FROM usuarios WHERE papel = 'funcionario' AND ativo = TRUE ORDER BY nome");
    const fr = await funcRef();
    const etqs = await db.query(
      `SELECT e.indice, e.codigo, e.codigo_externo, e.status, e.despachado_em, l.item_nome
       FROM etiquetas e LEFT JOIN linhas l ON l.id = e.linha_id
       WHERE e.pedido_id = $1 ORDER BY e.indice`, [pedido.id]
    );
    const etqDespachadas = etqs.rows.filter((e) => e.status === 'despachado').length;
    // Metadados da NF anexada (sem carregar o PDF).
    const nfRow = await db.query("SELECT nome, to_char(criado_em, 'DD/MM/YYYY HH24:MI') AS em FROM notas_fiscais WHERE pedido_id = $1", [pedido.id]);
    const nf = nfRow.rowCount ? nfRow.rows[0] : null;
    // Parcelas (retirada parcelada): lançamentos com parcela_num.
    let parcelas = [];
    if (pedido.tipo === 'retirada') {
      const pp = await db.query("SELECT parcela_num, parcela_total, valor_centavos, to_char(vencimento, 'DD/MM/YYYY') AS venc, status FROM financeiro WHERE pedido_id = $1 AND parcela_num IS NOT NULL ORDER BY parcela_num", [pedido.id]);
      parcelas = pp.rows;
    }
    res.render('admin/pedido', {
      pedido, linhas: linhas.rows, reps: reps.rows, funcs: funcs.rows, funcRef: fr, nf, parcelas,
      taxaFuncCentavos: fr ? fr.taxa_etiqueta_centavos * pedido.total_etiquetas : null,
      passos: andamentoDisplay(pedido),
      etiquetas: etqs.rows, etqDespachadas, etqTotal: etqs.rowCount,
      expirado: etiquetasExpiradas(pedido.etiquetas_expira_em), horas: horasRestantes(pedido.etiquetas_expira_em),
      erro: req.query.erro || null, ok: req.query.ok || null,
      formatBRL, formatDateTime, formatPercent,
    });
  } catch (e) { next(e); }
});

// Excluir pedido (ex.: teste): exige senha do admin. Estorna o estoque (reserva e despacho),
// devolve/retira credito em conta ligado ao lancamento e apaga pedido, linhas, etiquetas,
// arquivos e financeiro (cascata). Irreversivel.
router.post('/pedido/:id/excluir', async (req, res, next) => {
  const client = await db.getClient();
  const pid = pInt(req.params.id);
  try {
    const senha = (req.body.senha || '').toString();
    const adm = await db.query("SELECT senha_hash FROM usuarios WHERE id = $1 AND papel = 'admin'", [req.session.user.id]);
    if (adm.rowCount === 0 || !senha || !(await bcrypt.compare(senha, adm.rows[0].senha_hash))) {
      return res.redirect('/admin/pedido/' + pid + '?erro=' + encodeURIComponent('Senha do administrador incorreta. O pedido não foi excluído.'));
    }
    await client.query('BEGIN');
    const p = await client.query('SELECT id, numero, cliente_id FROM pedidos WHERE id = $1 FOR UPDATE', [pid]);
    if (p.rowCount === 0) { await client.query('ROLLBACK'); return naoEncontrado(res, req); }
    const numero = p.rows[0].numero, clienteId = p.rows[0].cliente_id;

    // 1) estoque: reverte exatamente o que este pedido movimentou (reserva, despacho, liberacao)
    const mv = await client.query(
      `SELECT produto_id, cor_id, cor_nome, sum(quantidade)::int AS q, sum(reserva)::int AS r
       FROM estoque_mov WHERE pedido_id = $1 GROUP BY produto_id, cor_id, cor_nome`, [pid]
    );
    for (const m of mv.rows) {
      if (m.q === 0 && m.r === 0) continue;
      await estoque.movimentar(client, { produtoId: m.produto_id, corId: m.cor_id, corNome: m.cor_nome, quantidade: -m.q, reserva: -m.r, motivo: 'Estorno', observacao: 'pedido ' + numero + ' excluído', pedidoId: null, usuarioId: req.session.user.id });
    }
    // 2) credito em conta ligado ao lancamento
    const f = await client.query('SELECT status, credito_usado_centavos, credito_gerado_centavos FROM financeiro WHERE pedido_id = $1', [pid]);
    if (f.rowCount) {
      const usado = Number(f.rows[0].credito_usado_centavos || 0);
      const gerado = f.rows[0].status === 'pago' ? Number(f.rows[0].credito_gerado_centavos || 0) : 0;
      const delta = usado - gerado;
      if (delta !== 0) await client.query('UPDATE clientes SET credito_centavos = GREATEST(0, credito_centavos + $2) WHERE id = $1', [clienteId, delta]);
    }
    // 3) apaga (cascata: linhas, etiquetas, arquivos, financeiro; estoque_mov fica com pedido_id nulo)
    await client.query('DELETE FROM pedidos WHERE id = $1', [pid]);
    await client.query('COMMIT');
    res.redirect('/admin/pedidos?ok=' + encodeURIComponent('Pedido ' + numero + ' excluído; estoque e crédito estornados.'));
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});
// Funcionario do pedido (taxa por etiqueta gravada na atribuicao).
router.post('/pedido/:id/funcionario', async (req, res, next) => {
  try {
    const funcId = pInt(req.body.funcionario_id);
    if (!funcId) { await db.query('UPDATE pedidos SET funcionario_id = NULL, taxa_func_centavos = NULL WHERE id = $1', [req.params.id]); return res.redirect('/admin/pedido/' + req.params.id); }
    const f = await db.query("SELECT taxa_etiqueta_centavos FROM usuarios WHERE id = $1 AND papel = 'funcionario'", [funcId]);
    if (f.rowCount === 0) return res.redirect('/admin/pedido/' + req.params.id);
    let taxa = parsePrecoToCentavos(req.body.taxa);
    if (taxa === null) taxa = f.rows[0].taxa_etiqueta_centavos || 0;
    await db.query('UPDATE pedidos SET funcionario_id = $1, taxa_func_centavos = $2 WHERE id = $3', [funcId, taxa, req.params.id]);
    res.redirect('/admin/pedido/' + req.params.id);
  } catch (e) { next(e); }
});
router.post('/pedido/:id/comissao', async (req, res, next) => {
  try {
    const pr = await db.query('SELECT id, total_centavos FROM pedidos WHERE id = $1', [req.params.id]);
    if (pr.rowCount === 0) return naoEncontrado(res, req);
    const total = pr.rows[0].total_centavos;
    const repId = pInt(req.body.representante_id);
    if (!repId) {
      await db.query('UPDATE pedidos SET representante_id = NULL, comissao_bps = NULL, comissao_centavos = 0, responsavel_id = NULL, comissao_resp_bps = NULL, comissao_resp_centavos = NULL WHERE id = $1', [req.params.id]);
      return res.redirect('/admin/pedido/' + req.params.id);
    }
    const rep = await db.query("SELECT comissao_bps FROM usuarios WHERE id = $1 AND papel = 'representante'", [repId]);
    if (rep.rowCount === 0) return res.redirect('/admin/pedido/' + req.params.id);
    let bps = parsePercentToBps(req.body.percent);
    if (bps === null) bps = rep.rows[0].comissao_bps || 0;
    // Override manual = um unico representante; limpa a divisao (preposto) deste pedido.
    await db.query('UPDATE pedidos SET representante_id = $1, comissao_bps = $2, comissao_centavos = $3, responsavel_id = NULL, comissao_resp_bps = NULL, comissao_resp_centavos = NULL WHERE id = $4', [repId, bps, comissaoCentavos(total, bps), req.params.id]);
    res.redirect('/admin/pedido/' + req.params.id);
  } catch (e) { next(e); }
});

router.post('/pedido/:id/status', async (req, res, next) => {
  try {
    const acao = req.body.acao;
    if (acao === 'preparar') {
      await db.query("UPDATE pedidos SET status = 'preparando', preparando_em = COALESCE(preparando_em, now()) WHERE id = $1 AND status = 'aguardando'", [req.params.id]);
    } else if (acao === 'despachar') {
      await db.query("UPDATE pedidos SET status = 'despachado', despachado_em = now(), preparando_em = COALESCE(preparando_em, now()) WHERE id = $1 AND status <> 'despachado'", [req.params.id]);
    } else if (acao === 'reabrir') {
      await db.query("UPDATE pedidos SET status = 'aguardando', despachado_em = NULL, preparando_em = NULL WHERE id = $1", [req.params.id]);
    }
    res.redirect('/admin/pedido/' + req.params.id);
  } catch (e) { next(e); }
});

// Download: etiquetas (72h) - arquivos separados nomeados pelo produto.
router.get('/pedido/:id/etiquetas', async (req, res, next) => {
  try {
    const p = await db.query('SELECT id, numero, etiquetas_expira_em FROM pedidos WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0) return naoEncontrado(res, req);
    if (etiquetasExpiradas(p.rows[0].etiquetas_expira_em)) {
      return res.status(410).render('erro', { titulo: 'Etiquetas expiradas', mensagem: 'As etiquetas deste pedido expiraram (72h). O cliente precisa reenviar.', user: req.session.user });
    }
    const arqs = await db.query(
      `SELECT a.nome AS arquivo_nome, a.conteudo, l.item_nome
       FROM arquivos a LEFT JOIN linhas l ON l.arquivo_id = a.id WHERE a.pedido_id = $1 ORDER BY a.id`, [p.rows[0].id]
    );
    if (arqs.rowCount === 0) return naoEncontrado(res, req);
    enviarEtiquetas(res, p.rows[0].numero, arqs.rows);
  } catch (e) { next(e); }
});

router.get('/pedido/:id/comprovante', async (req, res, next) => {
  try {
    const p = await db.query('SELECT numero, comprovante FROM pedidos WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0 || !p.rows[0].comprovante) return naoEncontrado(res, req);
    enviarPdf(res, 'comprovante-' + p.rows[0].numero + '.pdf', p.rows[0].comprovante);
  } catch (e) { next(e); }
});

// ----- Nota fiscal: anexar (upload do PDF) e baixar. Só o admin completo anexa. -----
router.post('/pedido/:id/nota-fiscal', exigeAdminFull, (req, res, next) => {
  uploadNf.single('nota')(req, res, (err) => {
    if (err) return res.redirect('/admin/pedido/' + pInt(req.params.id) + '?erro=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'O PDF passa de 10 MB.' : 'Falha no envio do arquivo.'));
    next();
  });
}, async (req, res) => {
  const pid = pInt(req.params.id);
  try {
    const ped = await db.query('SELECT id, com_nf FROM pedidos WHERE id = $1', [pid]);
    if (ped.rowCount === 0) return res.redirect('/admin/pedidos');
    if (!ped.rows[0].com_nf) return res.redirect('/admin/pedido/' + pid + '?erro=' + encodeURIComponent('Este pedido não foi pedido com nota fiscal.'));
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.redirect('/admin/pedido/' + pid + '?erro=' + encodeURIComponent('Anexe o PDF da nota fiscal.'));
    const nome = (req.file.originalname || 'nota-fiscal.pdf').toString().slice(0, 180);
    await db.query(
      `INSERT INTO notas_fiscais (pedido_id, conteudo, nome, criado_em) VALUES ($1, $2, $3, now())
       ON CONFLICT (pedido_id) DO UPDATE SET conteudo = EXCLUDED.conteudo, nome = EXCLUDED.nome, criado_em = now()`,
      [pid, req.file.buffer, nome]
    );
    res.redirect('/admin/pedido/' + pid + '?ok=' + encodeURIComponent('Nota fiscal anexada. O cliente já pode baixar.'));
  } catch (e) { res.redirect('/admin/pedido/' + pid + '?erro=' + encodeURIComponent('Falha ao salvar a nota fiscal.')); }
});

router.get('/pedido/:id/nota-fiscal', async (req, res, next) => {
  try {
    const nf = await db.query('SELECT n.conteudo, p.numero FROM notas_fiscais n JOIN pedidos p ON p.id = n.pedido_id WHERE n.pedido_id = $1', [pInt(req.params.id)]);
    if (nf.rowCount === 0 || !nf.rows[0].conteudo) return naoEncontrado(res, req);
    enviarPdf(res, 'nota-fiscal-' + nf.rows[0].numero + '.pdf', nf.rows[0].conteudo);
  } catch (e) { next(e); }
});

// ===================== RETIRADA NO CD =====================
// Formulario para criar uma retirada (cliente retira a mercadoria no CD). Só admin completo.
router.get('/retirada/nova', exigeAdminFull, async (req, res, next) => {
  try {
    const clientes = await db.query('SELECT id, nome FROM clientes ORDER BY nome');
    const nfBps = await config.nfBps(db);
    res.render('admin/retirada-nova', { clientes: clientes.rows, nfBps, erro: req.query.erro || null, formatBRL });
  } catch (e) { next(e); }
});

// Catalogo (produtos com preço) de um cliente, para montar a retirada no navegador.
router.get('/retirada/itens', exigeAdminFull, async (req, res) => {
  try {
    const clienteId = pInt(req.query.cliente);
    if (!clienteId) return res.json({ ok: true, itens: [] });
    const cat = await catalogoDoCliente(db, clienteId);
    const itens = cat.map((x) => ({
      id: x.id, produto_id: x.produto_id, nome: x.nome, preco_centavos: x.preco_centavos,
      cores: (x.cores || []).map((c) => ({ id: c.id, nome: c.nome, sku: c.sku, saldo: c.saldo })),
    }));
    res.json({ ok: true, itens });
  } catch (e) { console.error('Erro retirada/itens:', e); res.status(500).json({ erro: 'Falha ao carregar os produtos.' }); }
});

// Atribui a comissao de uma retirada a partir do cadastro do cliente (preposto + representante-pai),
// calculada SOBRE O PRECO DE SISTEMA (preco_base_centavos) — o acrescimo de venda nao entra na comissao.
//   representante_id = preposto (fatia dele) · responsavel_id = pai (resto do total).
async function atribuirComissaoRetirada(client, pedidoId, clienteId, linhas) {
  const cc = await client.query(
    `SELECT c.comissao_total_bps, c.comissao_preposto_bps, u.id AS u_id, u.comissao_bps AS u_bps, u.representante_pai_id
     FROM clientes c LEFT JOIN usuarios u ON u.id = c.representante_id AND u.papel = 'representante'
     WHERE c.id = $1`, [clienteId]
  );
  const comRow = cc.rows[0];
  if (!comRow || !comRow.u_id) {
    await client.query('UPDATE pedidos SET representante_id = NULL, comissao_bps = NULL, comissao_centavos = 0, responsavel_id = NULL, comissao_resp_bps = NULL, comissao_resp_centavos = NULL WHERE id = $1', [pedidoId]);
    return;
  }
  const normalTotalBps = parseInt(comRow.comissao_total_bps != null ? comRow.comissao_total_bps : (comRow.u_bps || 0), 10) || 0;
  const temPai = !!comRow.representante_pai_id;
  let prepRatio = 0;
  if (temPai && normalTotalBps > 0) {
    let prepNormal = parseInt(comRow.comissao_preposto_bps != null ? comRow.comissao_preposto_bps : (comRow.u_bps || 0), 10) || 0;
    if (prepNormal > normalTotalBps) prepNormal = normalTotalBps;
    prepRatio = prepNormal / normalTotalBps;
  }
  let somaPrep = 0, somaPai = 0, baseTotal = 0;
  let prepBps = 0, paiBps = 0;
  if (temPai) { prepBps = Math.min(normalTotalBps, Math.round(normalTotalBps * prepRatio)); paiBps = normalTotalBps - prepBps; }
  else { prepBps = normalTotalBps; paiBps = 0; }
  for (const l of linhas) {
    const baseLinha = (Number(l.precoBaseCentavos) || 0) * (Number(l.quantidade) || 0);
    baseTotal += baseLinha;
    if (normalTotalBps <= 0) continue;
    somaPrep += Math.round(baseLinha * prepBps / 10000);
    somaPai += Math.round(baseLinha * paiBps / 10000);
  }
  const blendPrep = baseTotal > 0 ? Math.round(somaPrep * 10000 / baseTotal) : 0;
  if (temPai) {
    const blendPai = baseTotal > 0 ? Math.round(somaPai * 10000 / baseTotal) : 0;
    await client.query(
      `UPDATE pedidos SET representante_id = $2, comissao_bps = $3, comissao_centavos = $4,
              responsavel_id = $5, comissao_resp_bps = $6, comissao_resp_centavos = $7 WHERE id = $1`,
      [pedidoId, comRow.u_id, blendPrep, somaPrep, comRow.representante_pai_id, blendPai, somaPai]
    );
  } else {
    await client.query(
      `UPDATE pedidos SET representante_id = $2, comissao_bps = $3, comissao_centavos = $4,
              responsavel_id = NULL, comissao_resp_bps = NULL, comissao_resp_centavos = NULL WHERE id = $1`,
      [pedidoId, comRow.u_id, blendPrep, somaPrep]
    );
  }
}

// Atribui o unico funcionario ativo (com taxa) ao pedido, se houver exatamente um. Com 0 ou 2+, fica manual.
async function atribuirFuncionarioUnico(client, pedidoId) {
  const fr = await client.query("SELECT id, taxa_etiqueta_centavos FROM usuarios WHERE papel = 'funcionario' AND ativo = TRUE AND taxa_etiqueta_centavos IS NOT NULL ORDER BY id");
  if (fr.rowCount === 1) {
    await client.query('UPDATE pedidos SET funcionario_id = $2, taxa_func_centavos = $3 WHERE id = $1', [pedidoId, fr.rows[0].id, fr.rows[0].taxa_etiqueta_centavos]);
  }
}

// Cria a retirada: monta o pedido (tipo retirada), reserva o estoque e lança no financeiro.
router.post('/retirada', exigeAdminFull, async (req, res) => {
  const body = req.body || {};
  const clienteId = pInt(body.clienteId);
  let itensReq = [];
  try { itensReq = typeof body.itens === 'string' ? JSON.parse(body.itens) : (Array.isArray(body.itens) ? body.itens : []); } catch (e) { itensReq = []; }
  if (!clienteId) return res.redirect('/admin/retirada/nova?erro=' + encodeURIComponent('Escolha o cliente.'));
  if (!Array.isArray(itensReq) || itensReq.length === 0) return res.redirect('/admin/retirada/nova?erro=' + encodeURIComponent('Adicione ao menos um produto.'));

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const cliRow = await client.query('SELECT id, nome, email FROM clientes WHERE id = $1', [clienteId]);
    if (cliRow.rowCount === 0) throw new Error('Cliente inválido.');
    const catMap = new Map((await catalogoDoCliente(client, clienteId)).map((i) => [String(i.id), i]));

    const linhas = [];
    let totalCentavos = 0, totalQtd = 0;
    for (const l of itensReq) {
      const qtd = parseInt(l.quantidade, 10);
      if (!qtd || qtd < 1) throw new Error('Quantidade inválida em uma das linhas.');
      const item = catMap.get(String(l.itemId));
      if (!item) throw new Error('Produto inválido para este cliente.');
      let cor = null;
      if (item.cores && item.cores.length > 0) {
        const corId = parseInt(l.corId, 10);
        cor = item.cores.find((c) => c.id === corId) || null;
        if (!cor) throw new Error('Escolha a cor de "' + item.nome + '".');
      }
      const itemId = await garantirItem(client, clienteId, item);
      const custoRow = await client.query('SELECT custo_centavos FROM produtos WHERE id = $1', [item.produto_id]);
      const custoCentavos = (custoRow.rowCount && custoRow.rows[0].custo_centavos !== null) ? Number(custoRow.rows[0].custo_centavos) : null;
      // Preco de sistema (base) e preco de venda do preposto (opcional). Venda >= base; a diferenca e o acrescimo.
      const baseCentavos = item.preco_centavos;
      let vendaCentavos = baseCentavos;
      const vTxt = (l.precoVenda == null ? '' : String(l.precoVenda)).trim();
      if (vTxt !== '') { const v = parsePrecoToCentavos(vTxt); if (v !== null && v > baseCentavos) vendaCentavos = v; }
      const totalLinha = vendaCentavos * qtd;
      totalCentavos += totalLinha; totalQtd += qtd;
      linhas.push({ itemId, itemNome: cor ? item.nome + ' · ' + cor.nome : item.nome, corId: cor ? cor.id : null, corNome: cor ? cor.nome : null, sku: cor ? cor.sku : null, precoCentavos: vendaCentavos, precoBaseCentavos: baseCentavos, quantidade: qtd, totalCentavos: totalLinha, custoCentavos });
    }

    // Nota fiscal (mesmas regras dos pedidos): taxa do admin, parcela escolhida (min 30%).
    const nfTaxaBps = await config.nfBps(client);
    const comNf = body.comNf === 'true' || body.comNf === 'on' || body.comNf === true;
    let nfParcelaBps = null, impostoCentavos = 0, comNfFinal = false;
    if (comNf && nfTaxaBps > 0) {
      comNfFinal = true;
      let parcela = parseInt(body.nfParcela, 10);
      if (isNaN(parcela)) parcela = 3000;
      parcela = Math.max(3000, Math.min(10000, parcela));
      nfParcelaBps = parcela;
      impostoCentavos = Math.round(totalCentavos * parcela / 10000 * nfTaxaBps / 10000);
    }
    const totalComImposto = totalCentavos + impostoCentavos;

    const numero = (await client.query("SELECT 'RT-' || nextval('retirada_numero_seq') AS numero")).rows[0].numero;
    const ped = await client.query(
      `INSERT INTO pedidos (numero, cliente_id, usuario_id, tipo, status, total_centavos, total_etiquetas, aceite_em, com_nf, nf_bps, nf_parcela_bps, imposto_centavos)
       VALUES ($1,$2,$3,'retirada','aguardando',$4,$5, now(), $6,$7,$8,$9) RETURNING id`,
      [numero, clienteId, req.session.user.id, totalComImposto, totalQtd, comNfFinal, comNfFinal ? nfTaxaBps : null, nfParcelaBps, impostoCentavos]
    );
    const pedidoId = ped.rows[0].id;
    for (const l of linhas) {
      await client.query(
        `INSERT INTO linhas (pedido_id, arquivo_id, item_id, item_nome, arquivo_nome, preco_centavos, preco_base_centavos, quantidade, total_centavos, cor_id, cor_nome, sku, custo_centavos)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [pedidoId, l.itemId, l.itemNome, 'Retirada no CD', l.precoCentavos, l.precoBaseCentavos, l.quantidade, l.totalCentavos, l.corId, l.corNome, l.sku, l.custoCentavos]
      );
    }
    await atribuirComissaoRetirada(client, pedidoId, clienteId, linhas);
    await atribuirFuncionarioUnico(client, pedidoId);
    await estoque.reservarPedido(client, pedidoId, req.session.user.id);

    // Pagamento: a vista (um lancamento) ou parcelado (uma parcela por data, valores iguais).
    let parcelaVencs = [];
    try { parcelaVencs = typeof body.parcelaVencs === 'string' ? JSON.parse(body.parcelaVencs) : (Array.isArray(body.parcelaVencs) ? body.parcelaVencs : []); } catch (e) { parcelaVencs = []; }
    const nParcelas = parseInt(body.parcelas, 10) || 1;
    let msgPag = 'lancei no financeiro do cliente';
    if (nParcelas > 1) {
      if (parcelaVencs.length !== nParcelas) throw new Error('As datas das parcelas estão incompletas.');
      const vencs = parcelaVencs.map((d) => {
        const s = String(d).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Data de parcela inválida.');
        return { venc: s };
      });
      await financeiro.criarParcelas(client, pedidoId, clienteId, totalComImposto, vencs);
      msgPag = 'lancei em ' + nParcelas + ' parcelas no financeiro do cliente';
    } else {
      await financeiro.criarLancamento(client, pedidoId, clienteId, totalComImposto, totalQtd);
    }
    await client.query('COMMIT');
    res.redirect('/admin/pedido/' + pedidoId + '?ok=' + encodeURIComponent('Retirada ' + numero + ' criada. Reservei o estoque e ' + msgPag + '.'));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.redirect('/admin/retirada/nova?erro=' + encodeURIComponent(e.message || 'Falha ao criar a retirada.'));
  } finally { client.release(); }
});

// Editar retirada (só enquanto aguardando): abre a tela de criação pré-preenchida.
router.get('/pedido/:id/editar', exigeAdminFull, async (req, res, next) => {
  try {
    const pid = pInt(req.params.id);
    const pr = await db.query('SELECT p.*, c.nome AS cliente_nome FROM pedidos p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = $1', [pid]);
    if (pr.rowCount === 0 || pr.rows[0].tipo !== 'retirada') return naoEncontrado(res, req);
    const ped = pr.rows[0];
    if (ped.status !== 'aguardando') return res.redirect('/admin/pedido/' + pid + '?erro=' + encodeURIComponent('Só dá para editar enquanto a retirada está aguardando.'));
    const linhas = await db.query('SELECT l.quantidade, l.cor_id, l.preco_centavos, l.preco_base_centavos, i.produto_id FROM linhas l LEFT JOIN itens i ON i.id = l.item_id WHERE l.pedido_id = $1 ORDER BY l.id', [pid]);
    const parc = await db.query("SELECT to_char(vencimento, 'YYYY-MM-DD') AS venc FROM financeiro WHERE pedido_id = $1 AND parcela_num IS NOT NULL ORDER BY parcela_num", [pid]);
    const nfBps = await config.nfBps(db);
    const edit = {
      pedidoId: pid, clienteId: ped.cliente_id, clienteNome: ped.cliente_nome,
      comNf: ped.com_nf, nfBps: ped.nf_bps, nfParcelaBps: ped.nf_parcela_bps, numero: ped.numero,
      itens: linhas.rows.filter((r) => r.produto_id).map((r) => {
        // Pré-preenche o preço de venda só quando houve acréscimo (venda acima do preço de sistema).
        const base = r.preco_base_centavos != null ? r.preco_base_centavos : r.preco_centavos;
        const venda = (r.preco_centavos != null && base != null && r.preco_centavos > base)
          ? (r.preco_centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
        return { produtoId: r.produto_id, corId: r.cor_id, quantidade: r.quantidade, venda };
      }),
      parcelaVencs: parc.rows.map((r) => r.venc),
    };
    res.render('admin/retirada-nova', { clientes: [{ id: ped.cliente_id, nome: ped.cliente_nome }], nfBps, edit, erro: req.query.erro || null, formatBRL });
  } catch (e) { next(e); }
});

router.post('/pedido/:id/editar', exigeAdminFull, async (req, res) => {
  const pid = pInt(req.params.id);
  const body = req.body || {};
  let itensReq = [];
  try { itensReq = typeof body.itens === 'string' ? JSON.parse(body.itens) : (Array.isArray(body.itens) ? body.itens : []); } catch (e) { itensReq = []; }
  if (!Array.isArray(itensReq) || itensReq.length === 0) return res.redirect('/admin/pedido/' + pid + '/editar?erro=' + encodeURIComponent('Adicione ao menos um produto.'));
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const ped = (await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [pid])).rows[0];
    if (!ped || ped.tipo !== 'retirada') { await client.query('ROLLBACK'); return res.redirect('/admin/pedidos'); }
    if (ped.status !== 'aguardando') throw new Error('Só dá para editar enquanto a retirada está aguardando.');
    const clienteId = ped.cliente_id;
    const catMap = new Map((await catalogoDoCliente(client, clienteId)).map((i) => [String(i.id), i]));
    const linhas = [];
    let totalCentavos = 0, totalQtd = 0;
    for (const l of itensReq) {
      const qtd = parseInt(l.quantidade, 10);
      if (!qtd || qtd < 1) throw new Error('Quantidade inválida em uma das linhas.');
      const item = catMap.get(String(l.itemId));
      if (!item) throw new Error('Produto inválido para este cliente.');
      let cor = null;
      if (item.cores && item.cores.length > 0) {
        const corId = parseInt(l.corId, 10);
        cor = item.cores.find((c) => c.id === corId) || null;
        if (!cor) throw new Error('Escolha a cor de "' + item.nome + '".');
      }
      const itemId = await garantirItem(client, clienteId, item);
      const custoRow = await client.query('SELECT custo_centavos FROM produtos WHERE id = $1', [item.produto_id]);
      const custoCentavos = (custoRow.rowCount && custoRow.rows[0].custo_centavos !== null) ? Number(custoRow.rows[0].custo_centavos) : null;
      const baseCentavos = item.preco_centavos;
      let vendaCentavos = baseCentavos;
      const vTxt = (l.precoVenda == null ? '' : String(l.precoVenda)).trim();
      if (vTxt !== '') { const v = parsePrecoToCentavos(vTxt); if (v !== null && v > baseCentavos) vendaCentavos = v; }
      const totalLinha = vendaCentavos * qtd;
      totalCentavos += totalLinha; totalQtd += qtd;
      linhas.push({ itemId, itemNome: cor ? item.nome + ' · ' + cor.nome : item.nome, corId: cor ? cor.id : null, corNome: cor ? cor.nome : null, sku: cor ? cor.sku : null, precoCentavos: vendaCentavos, precoBaseCentavos: baseCentavos, quantidade: qtd, totalCentavos: totalLinha, custoCentavos });
    }
    // Estorna a reserva atual e limpa linhas/lancamentos antigos.
    await estoque.estornarReserva(client, pid, req.session.user.id);
    await client.query('DELETE FROM financeiro WHERE pedido_id = $1', [pid]);
    await client.query('DELETE FROM linhas WHERE pedido_id = $1', [pid]);
    // NF mantida como estava: recalcula o imposto sobre a nova base.
    const impostoCentavos = ped.com_nf ? Math.round(totalCentavos * (ped.nf_parcela_bps / 10000) * (ped.nf_bps / 10000)) : 0;
    const totalComImposto = totalCentavos + impostoCentavos;
    for (const l of linhas) {
      await client.query(
        `INSERT INTO linhas (pedido_id, arquivo_id, item_id, item_nome, arquivo_nome, preco_centavos, preco_base_centavos, quantidade, total_centavos, cor_id, cor_nome, sku, custo_centavos)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [pid, l.itemId, l.itemNome, 'Retirada no CD', l.precoCentavos, l.precoBaseCentavos, l.quantidade, l.totalCentavos, l.corId, l.corNome, l.sku, l.custoCentavos]
      );
    }
    await atribuirComissaoRetirada(client, pid, clienteId, linhas);
    await estoque.reservarPedido(client, pid, req.session.user.id);
    // Pagamento (igual à criação): à vista ou parcelado por datas.
    let parcelaVencs = [];
    try { parcelaVencs = typeof body.parcelaVencs === 'string' ? JSON.parse(body.parcelaVencs) : (Array.isArray(body.parcelaVencs) ? body.parcelaVencs : []); } catch (e) { parcelaVencs = []; }
    const nParcelas = parseInt(body.parcelas, 10) || 1;
    if (nParcelas > 1) {
      if (parcelaVencs.length !== nParcelas) throw new Error('As datas das parcelas estão incompletas.');
      const vencs = parcelaVencs.map((d) => { const s = String(d).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Data de parcela inválida.'); return { venc: s }; });
      await financeiro.criarParcelas(client, pid, clienteId, totalComImposto, vencs);
    } else {
      await financeiro.criarLancamento(client, pid, clienteId, totalComImposto, totalQtd);
    }
    await client.query('UPDATE pedidos SET total_centavos = $2, total_etiquetas = $3, imposto_centavos = $4 WHERE id = $1', [pid, totalComImposto, totalQtd, impostoCentavos]);
    await client.query('COMMIT');
    res.redirect('/admin/pedido/' + pid + '?ok=' + encodeURIComponent('Retirada ' + ped.numero + ' atualizada.'));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.redirect('/admin/pedido/' + pid + '/editar?erro=' + encodeURIComponent(e.message || 'Falha ao salvar as alterações.'));
  } finally { client.release(); }
});

// Confirma que o cliente retirou: baixa o estoque (fisico) e marca como retirado.
router.post('/pedido/:id/confirmar-retirada', exigeAdminFull, async (req, res) => {
  const pid = pInt(req.params.id);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT id, tipo, status FROM pedidos WHERE id = $1 FOR UPDATE', [pid]);
    if (p.rowCount === 0 || p.rows[0].tipo !== 'retirada') { await client.query('ROLLBACK'); return res.redirect('/admin/pedidos'); }
    if (p.rows[0].status === 'retirado') { await client.query('ROLLBACK'); return res.redirect('/admin/pedido/' + pid + '?ok=' + encodeURIComponent('Esta retirada já estava confirmada.')); }
    await estoque.baixarRetirada(client, pid, req.session.user.id);
    await client.query("UPDATE pedidos SET status = 'retirado', retirado_em = now() WHERE id = $1", [pid]);
    await client.query('COMMIT');
    res.redirect('/admin/pedido/' + pid + '?ok=' + encodeURIComponent('Retirada confirmada. O estoque foi baixado.'));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.redirect('/admin/pedido/' + pid + '?erro=' + encodeURIComponent('Falha ao confirmar a retirada.'));
  } finally { client.release(); }
});

// Comprovante de retirada (PDF, gerado na hora).
router.get('/pedido/:id/retirada.pdf', async (req, res, next) => {
  try {
    const pr = await db.query('SELECT p.*, c.nome AS cliente_nome, c.email AS cliente_email FROM pedidos p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = $1', [pInt(req.params.id)]);
    if (pr.rowCount === 0 || pr.rows[0].tipo !== 'retirada') return naoEncontrado(res, req);
    const p = pr.rows[0];
    const linhas = await db.query('SELECT l.item_nome, l.quantidade, l.preco_centavos, l.total_centavos, pr.peso_gramas FROM linhas l LEFT JOIN itens i ON i.id = l.item_id LEFT JOIN produtos pr ON pr.id = i.produto_id WHERE l.pedido_id = $1 ORDER BY l.id', [p.id]);
    const fin = await db.query("SELECT valor_centavos, to_char(vencimento, 'DD/MM/YYYY') AS venc_br, parcela_num, parcela_total FROM financeiro WHERE pedido_id = $1 ORDER BY parcela_num NULLS FIRST, id", [p.id]);
    const pdf = await gerarComprovanteRetirada(montarDados(p, linhas.rows, fin.rows));
    enviarPdf(res, 'retirada-' + p.numero + '.pdf', pdf);
  } catch (e) { next(e); }
});

// Extrato do representante/preposto de uma retirada (interno). Comissao sobre o preco de SISTEMA
// + acrescimo (venda - sistema, 100% dele). NAO mostra o % do representante pai (Gabriel).
router.get('/pedido/:id/extrato-preposto.pdf', exigeAdminFull, async (req, res, next) => {
  try {
    const pr = await db.query(
      `SELECT p.id, p.numero, p.criado_em, p.tipo, c.nome AS cliente_nome,
              c.representante_id, c.comissao_total_bps, c.comissao_preposto_bps,
              rep.nome AS rep_nome, rep.representante_pai_id AS rep_pai_id
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios rep ON rep.id = c.representante_id
       WHERE p.id = $1`, [pInt(req.params.id)]);
    if (pr.rowCount === 0 || pr.rows[0].tipo !== 'retirada') return naoEncontrado(res, req);
    const p = pr.rows[0];
    // % do preposto: se o representante do cliente for um preposto, usa a parte dele (comissao_preposto_bps);
    // senao, usa a comissao total (representante direto). O pai nunca aparece aqui.
    const ehPreposto = p.rep_pai_id !== null && p.rep_pai_id !== undefined;
    let prepostoBps = 0;
    if (p.representante_id) prepostoBps = Number(ehPreposto ? (p.comissao_preposto_bps || 0) : (p.comissao_total_bps || 0)) || 0;
    const prepostoNome = p.rep_nome || (p.representante_id ? '—' : '(sem representante definido)');

    const lin = await db.query(
      `SELECT item_nome, quantidade, preco_centavos, COALESCE(preco_base_centavos, preco_centavos) AS base_centavos
       FROM linhas WHERE pedido_id = $1 ORDER BY id`, [p.id]);
    let totComissao = 0, totAdicional = 0;
    const linhas = lin.rows.map((l) => {
      const qtd = Number(l.quantidade) || 0;
      const base = Number(l.base_centavos) || 0;
      const venda = Number(l.preco_centavos) || 0;
      const comissao = Math.round(base * qtd * prepostoBps / 10000);
      const adicional = Math.max(0, venda - base) * qtd;
      totComissao += comissao; totAdicional += adicional;
      return { nome: l.item_nome, qtd, baseCentavos: base, vendaCentavos: venda, comissaoCentavos: comissao, adicionalCentavos: adicional };
    });
    const pdf = await gerarExtratoPreposto({
      numero: p.numero, criadoEm: p.criado_em,
      empresa: { nome: process.env.EMPRESA_NOME || 'A4 Móveis Distribuidora', cnpj: process.env.EMPRESA_CNPJ || '', contato: process.env.EMPRESA_CONTATO || '' },
      cliente: { nome: p.cliente_nome },
      preposto: { nome: prepostoNome, bps: prepostoBps },
      linhas, totComissao, totAdicional, totGeral: totComissao + totAdicional,
    });
    enviarPdf(res, 'extrato-preposto-' + p.numero + '.pdf', pdf);
  } catch (e) { next(e); }
});

// ===================== FINANCEIRO =====================
router.get('/financeiro', async (req, res, next) => {
  try {
    const clienteId = pInt(req.query.cliente);
    const sit = ['todos', 'aberto', 'vencido', 'pago', 'cancelado'].includes(req.query.situacao) ? req.query.situacao : 'aberto';
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : '';
    const todos = await financeiro.listar({ clienteId });
    const lista = financeiro.filtrarSituacao(mes ? await financeiro.listar({ clienteId, mes }) : todos, sit);
    const clientes = await db.query('SELECT id, nome FROM clientes ORDER BY nome');
    // Total em aberto por cliente (visao rapida de quem deve).
    const porCliente = new Map();
    for (const l of todos) {
      if (l.situacao !== 'aberto' && l.situacao !== 'vencido') continue;
      const c = porCliente.get(l.cliente_id) || { id: l.cliente_id, nome: l.cliente_nome, aberto: 0, vencido: 0, qtd: 0 };
      c.aberto += l.valor_centavos; c.qtd++;
      if (l.situacao === 'vencido') c.vencido += l.valor_centavos;
      porCliente.set(l.cliente_id, c);
    }
    res.render('admin/financeiro', {
      ativo: 'adm-financeiro', lancamentos: lista, resumo: financeiro.resumo(todos),
      clientes: clientes.rows, meses: await financeiro.mesesDisponiveis(clienteId),
      porCliente: Array.from(porCliente.values()).sort((a, b) => b.aberto - a.aberto),
      filtro: { cliente: clienteId, situacao: sit, mes },
      formas: financeiro.FORMAS, hoje: financeiro.hojeISO(),
      ok: req.query.ok || null, erro: req.query.erro || null, formatBRL, formatDateTime,
    });
  } catch (e) { next(e); }
});
function voltarFin(req, extra) {
  const q = new URLSearchParams();
  const b = req.body || {};
  if (b.ret_cliente) q.set('cliente', b.ret_cliente);
  if (b.ret_situacao) q.set('situacao', b.ret_situacao);
  if (b.ret_mes) q.set('mes', b.ret_mes);
  Object.keys(extra || {}).forEach((k) => q.set(k, extra[k]));
  const s = q.toString();
  return '/admin/financeiro' + (s ? '?' + s : '');
}
router.post('/financeiro/:id/pagar', async (req, res, next) => {
  try {
    const id = pInt(req.params.id);
    const data = /^\d{4}-\d{2}-\d{2}$/.test(req.body.pago_em || '') ? req.body.pago_em : financeiro.hojeISO();
    const forma = financeiro.FORMAS.includes(req.body.forma) ? req.body.forma : 'Outro';
    const obs = (req.body.observacao || '').toString().trim().slice(0, 200) || null;
    const r = await db.query(
      `UPDATE financeiro SET status = 'pago', forma_pagamento = $2, observacao = $3,
         pago_em = ($4::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo'
       WHERE id = $1 AND status <> 'pago' RETURNING pedido_id`, [id, forma, obs, data]
    );
    if (r.rowCount === 0) return res.redirect(voltarFin(req, { erro: 'Lançamento não encontrado ou já pago.' }));
    const pn = await db.query('SELECT p.numero, p.cliente_id FROM pedidos p WHERE p.id = $1', [r.rows[0].pedido_id]);
    if (pn.rowCount) await novidades.registrar(db, { tipo: 'financeiro', clienteId: pn.rows[0].cliente_id, pedidoId: r.rows[0].pedido_id, titulo: 'Pagamento do pedido ' + pn.rows[0].numero + ' confirmado', detalhe: 'via ' + forma + ' · crédito liberado' });
    res.redirect(voltarFin(req, { ok: 'Pagamento registrado.' }));
  } catch (e) { next(e); }
});
router.post('/financeiro/:id/reabrir', async (req, res, next) => {
  try {
    await db.query("UPDATE financeiro SET status = 'aberto', pago_em = NULL, forma_pagamento = NULL WHERE id = $1 AND status = 'pago'", [pInt(req.params.id)]);
    res.redirect(voltarFin(req, { ok: 'Lançamento reaberto.' }));
  } catch (e) { next(e); }
});

// ===================== CLIENTES =====================
// Prazo de pagamento, limite de credito e bloqueio por vencido (edicao inline na lista).
router.post('/clientes/:id/prazo', async (req, res, next) => {
  try {
    const dias = pInt(req.body.prazo_dias);
    if (dias === null || dias < 0 || dias > 365) return res.redirect('/admin/clientes?erro=' + encodeURIComponent('Prazo inválido (0 a 365 dias).'));
    const limTxt = (req.body.limite || '').toString().trim();
    const limite = limTxt === '' ? null : parsePrecoToCentavos(limTxt);
    if (limTxt !== '' && limite === null) return res.redirect('/admin/clientes?erro=' + encodeURIComponent('Limite inválido. Use por exemplo 5000 ou 5.000,00 (vazio = sem limite).'));
    const bloquear = req.body.bloquear_vencido === '1';
    await db.query('UPDATE clientes SET prazo_dias = $2, limite_centavos = $3, bloquear_vencido = $4 WHERE id = $1', [pInt(req.params.id), dias, limite, bloquear]);
    res.redirect('/admin/clientes');
  } catch (e) { next(e); }
});
// Editar o nome (loja) do cliente. Muda só o nome; login, histórico, pedidos e financeiro são por id e continuam.
router.post('/clientes/:id/nome', async (req, res, next) => {
  const cid = pInt(req.params.id);
  try {
    const nome = (req.body.nome || '').toString().trim().replace(/\s+/g, ' ');
    if (nome.length < 2) throw new Error('Informe o nome do cliente (mínimo 2 caracteres).');
    if (nome.length > 120) throw new Error('Nome muito longo (máximo 120 caracteres).');
    const ex = await db.query('SELECT id FROM clientes WHERE id = $1', [cid]);
    if (ex.rowCount === 0) throw new Error('Cliente não encontrado.');
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE clientes SET nome = $2 WHERE id = $1', [cid, nome]);
      // o usuário de login do cliente tem o mesmo nome de exibição: mantém em sincronia
      await client.query("UPDATE usuarios SET nome = $2 WHERE cliente_id = $1 AND papel = 'cliente'", [cid, nome]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.redirect('/admin/clientes?ok=' + encodeURIComponent('Nome atualizado para "' + nome + '".'));
  } catch (e) { res.redirect('/admin/clientes?erro=' + encodeURIComponent(msgErro(e))); }
});
router.get('/clientes', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.nome, c.ativo, c.prazo_dias, c.limite_centavos, c.bloquear_vencido, c.telefone, u.login,
              c.representante_id, c.comissao_total_bps, c.comissao_preposto_bps,
              rep.nome AS rep_nome, rep.representante_pai_id AS rep_eh_preposto, pai.nome AS rep_pai_nome,
              (SELECT COALESCE(sum(f.valor_centavos), 0) FROM financeiro f WHERE f.cliente_id = c.id AND f.status = 'aberto')::int AS em_aberto,
              (SELECT count(*) FROM pedidos p WHERE p.cliente_id = c.id)::int AS pedidos,
              (SELECT count(*) FROM itens i WHERE i.cliente_id = c.id AND i.ativo AND i.negociado) AS produtos
       FROM clientes c
       LEFT JOIN usuarios u ON u.cliente_id = c.id AND u.papel = 'cliente'
       LEFT JOIN usuarios rep ON rep.id = c.representante_id
       LEFT JOIN usuarios pai ON pai.id = rep.representante_pai_id
       ORDER BY c.nome`
    );
    const repsLista = await db.query(
      `SELECT u.id, u.nome, u.comissao_bps, u.representante_pai_id, pai.nome AS pai_nome
       FROM usuarios u LEFT JOIN usuarios pai ON pai.id = u.representante_pai_id
       WHERE u.papel = 'representante' AND u.ativo = TRUE ORDER BY u.representante_pai_id NULLS FIRST, u.nome`
    );
    // acesso recem-criado (uma vez so)
    let acesso = null;
    if (req.session.acessoCliente) {
      const a = req.session.acessoCliente; delete req.session.acessoCliente;
      const site = 'https://' + (req.get('host') || 'distribuidoraeea.up.railway.app');
      const nomeEmpresa = process.env.EMPRESA_NOME || 'A4 Móveis Distribuidora';
      const manualUrl = process.env.MANUAL_CLIENTE_URL || null;
      const mensagem = montarMensagemAcesso({ nome: a.nome, login: a.login, senha: a.senha, site, empresa: nomeEmpresa, manualUrl });
      acesso = { nome: a.nome, login: a.login, telefone: a.telefone, mensagem, site };
    }
    res.render('admin/clientes', { clientes: r.rows, reps: repsLista.rows, acesso, ativo: 'clientes', erro: req.query.erro || null, ok: req.query.ok || null, formatBRL, formatPercent });
  } catch (e) { next(e); }
});
router.post('/clientes', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const nome = (req.body.nome || '').trim(), email = (req.body.email || '').trim(), login = (req.body.login || '').trim(), senha = req.body.senha || '';
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    let prazo = pInt(req.body.prazo_dias); if (prazo === null || prazo < 0 || prazo > 365) prazo = 7;
    const limTxt = (req.body.limite || '').toString().trim();
    const limite = limTxt === '' ? null : parsePrecoToCentavos(limTxt);
    if (limTxt !== '' && limite === null) throw new Error('Limite inválido. Use por exemplo 5000 ou 5.000,00 (vazio = sem limite).');
    const telefone = (req.body.telefone || '').toString().replace(/\D/g, '').slice(0, 15) || null;
    await client.query('BEGIN');
    const c = await client.query('INSERT INTO clientes (nome, email, prazo_dias, limite_centavos, telefone) VALUES ($1,$2,$3,$4,$5) RETURNING id', [nome, email || null, prazo, limite, telefone]);
    await client.query('INSERT INTO usuarios (nome, login, senha_hash, papel, cliente_id) VALUES ($1,$2,$3,$4,$5)', [nome, login, await bcrypt.hash(senha, 10), 'cliente', c.rows[0].id]);
    await client.query('COMMIT');
    // Mensagem de boas-vindas com o acesso: mostrada uma unica vez na proxima tela (a senha nao vai na URL).
    req.session.acessoCliente = { nome, login, senha, telefone, prazo, limite };
    res.redirect('/admin/clientes?ok=' + encodeURIComponent('Cliente "' + nome + '" cadastrado. A mensagem com o acesso está pronta abaixo.'));
  } catch (e) { await client.query('ROLLBACK'); res.redirect('/admin/clientes?erro=' + encodeURIComponent(msgErro(e))); } finally { client.release(); }
});
// Excluir cliente: exige a senha do admin logado. Apaga usuarios, precos, pedidos, etiquetas,
// arquivos e financeiro do cliente (cascata). Irreversivel.
router.post('/clientes/:id/excluir', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const id = pInt(req.params.id);
    const senha = (req.body.senha || '').toString();
    const adm = await db.query('SELECT senha_hash FROM usuarios WHERE id = $1 AND papel = $2', [req.session.user.id, 'admin']);
    if (adm.rowCount === 0 || !senha || !(await bcrypt.compare(senha, adm.rows[0].senha_hash))) {
      return res.redirect('/admin/clientes?erro=' + encodeURIComponent('Senha do administrador incorreta. O cliente não foi excluído.'));
    }
    await client.query('BEGIN');
    const c = await client.query('SELECT nome FROM clientes WHERE id = $1', [id]);
    if (c.rowCount === 0) { await client.query('ROLLBACK'); return res.redirect('/admin/clientes?erro=' + encodeURIComponent('Cliente não encontrado.')); }
    // arquivos subidos e ainda sem pedido (nao caem na cascata de pedidos)
    await client.query('DELETE FROM arquivos WHERE pedido_id IS NULL AND usuario_id IN (SELECT id FROM usuarios WHERE cliente_id = $1)', [id]);
    await client.query('DELETE FROM clientes WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.redirect('/admin/clientes?ok=' + encodeURIComponent('Cliente "' + c.rows[0].nome + '" excluído com todo o histórico.'));
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});
router.post('/clientes/:id/toggle', async (req, res, next) => {
  try {
    await db.query('UPDATE clientes SET ativo = NOT ativo WHERE id = $1', [req.params.id]);
    await db.query("UPDATE usuarios SET ativo = (SELECT ativo FROM clientes WHERE id = $1) WHERE cliente_id = $1 AND papel = 'cliente'", [req.params.id]);
    res.redirect('/admin/clientes');
  } catch (e) { next(e); }
});
// Comissao do cliente: quem agregou (representante ou preposto) + % total (+ fatia do preposto).
// Aplica automaticamente nos PROXIMOS pedidos do cliente.
router.post('/clientes/:id/comissao', exigeAdminFull, async (req, res, next) => {
  try {
    const id = pInt(req.params.id);
    const repId = pInt(req.body.representante_id);
    if (!repId) {
      await db.query('UPDATE clientes SET representante_id = NULL, comissao_total_bps = NULL, comissao_preposto_bps = NULL WHERE id = $1', [id]);
      return res.redirect('/admin/clientes?ok=' + encodeURIComponent('Comissão do cliente removida.'));
    }
    const u = await db.query("SELECT comissao_bps, representante_pai_id FROM usuarios WHERE id = $1 AND papel = 'representante'", [repId]);
    if (u.rowCount === 0) throw new Error('Representante/preposto inválido.');
    let totalBps = parsePercentToBps(req.body.total);
    if (totalBps === null) totalBps = u.rows[0].comissao_bps || 0;
    if (totalBps < 0 || totalBps >= 10000) throw new Error('Comissão total inválida.');
    let prepBps = null;
    if (u.rows[0].representante_pai_id) {
      prepBps = parsePercentToBps(req.body.preposto);
      if (prepBps === null) prepBps = u.rows[0].comissao_bps || 0;
      if (prepBps < 0) prepBps = 0;
      if (prepBps > totalBps) prepBps = totalBps;
    }
    await db.query('UPDATE clientes SET representante_id = $2, comissao_total_bps = $3, comissao_preposto_bps = $4 WHERE id = $1', [id, repId, totalBps, prepBps]);
    res.redirect('/admin/clientes?ok=' + encodeURIComponent('Comissão do cliente atualizada.'));
  } catch (e) { res.redirect('/admin/clientes?erro=' + encodeURIComponent(e.message || 'Falha ao salvar a comissão.')); }
});

// ===================== REPRESENTANTES =====================
router.get('/representantes', (req, res, next) => telaRepasses('representante', req, res, next));
// Repasses: marcar pago / reabrir / pagar todos liberados (tipo = representante | funcionario)
router.post('/repasses/:tipo/:pedidoId/pagar', async (req, res, next) => {
  const tipo = req.params.tipo === 'funcionario' ? 'funcionario' : 'representante';
  try {
    const data = /^\d{4}-\d{2}-\d{2}$/.test(req.body.pago_em || '') ? req.body.pago_em : hojeISO();
    const forma = repasses.FORMAS.includes(req.body.forma) ? req.body.forma : 'Outro';
    const p = await repasses.marcarPago(tipo, pInt(req.params.pedidoId), pInt(req.body.ret_usuario), data, forma);
    res.redirect(voltarRepasses(tipo, req, { ok: 'Repasse do pedido ' + p.numero + ' (' + formatBRL(p.valor) + ') marcado como pago.' }));
  } catch (e) { res.redirect(voltarRepasses(tipo, req, { erro: e.message || 'Falha ao marcar.' })); }
});
router.post('/repasses/:tipo/:pedidoId/reabrir', async (req, res, next) => {
  const tipo = req.params.tipo === 'funcionario' ? 'funcionario' : 'representante';
  try { await repasses.reabrir(tipo, pInt(req.params.pedidoId), pInt(req.body.ret_usuario)); res.redirect(voltarRepasses(tipo, req, { ok: 'Repasse reaberto.' })); }
  catch (e) { next(e); }
});
router.post('/repasses/:tipo/pagar-liberados', async (req, res, next) => {
  const tipo = req.params.tipo === 'funcionario' ? 'funcionario' : 'representante';
  try {
    const data = /^\d{4}-\d{2}-\d{2}$/.test(req.body.pago_em || '') ? req.body.pago_em : hojeISO();
    const forma = repasses.FORMAS.includes(req.body.forma) ? req.body.forma : 'Outro';
    const r = await repasses.pagarLiberados(tipo, pInt(req.body.usuario_id), data, forma);
    res.redirect(voltarRepasses(tipo, req, { ok: r.n + ' repasse(s) marcados como pagos, ' + formatBRL(r.total) + '.' }));
  } catch (e) { res.redirect(voltarRepasses(tipo, req, { erro: e.message || 'Falha ao marcar.' })); }
});
router.post('/representantes', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim(), login = (req.body.login || '').trim(), senha = req.body.senha || '';
    const bps = parsePercentToBps(req.body.comissao);
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    if (bps === null) throw new Error('Informe a comissão padrão (%).');
    // Preposto: representante que trabalha sob outro (o pai). Guarda tambem o total padrao do cliente.
    let paiId = null, totalBps = null;
    if (req.body.tipo === 'preposto') {
      paiId = pInt(req.body.pai_id);
      if (!paiId) throw new Error('Escolha o representante do qual este é preposto.');
      const pai = await db.query("SELECT id FROM usuarios WHERE id = $1 AND papel = 'representante' AND representante_pai_id IS NULL", [paiId]);
      if (pai.rowCount === 0) throw new Error('Representante-pai inválido (um preposto não pode ser pai de outro).');
      totalBps = parsePercentToBps(req.body.comissao_total);
      if (totalBps === null) totalBps = bps;              // sem total informado: usa a propria fatia
      if (totalBps < bps) throw new Error('A comissão total do cliente não pode ser menor que a fatia do preposto.');
    }
    const ins = await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel, comissao_bps, representante_pai_id, comissao_total_bps) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [nome, login, await bcrypt.hash(senha, 10), 'representante', bps, paiId, totalBps]);
    res.redirect('/admin/representantes?rep=' + ins.rows[0].id + '&ok=' + encodeURIComponent('Representante cadastrado.'));
  } catch (e) { res.redirect('/admin/representantes?cadastro=1&erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/representantes/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE usuarios SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/representantes?cadastro=1&rep=' + req.params.id); } catch (e) { next(e); }
});
// Comissao padrao / taxa (edicao inline no painel de cadastro)
router.post('/representantes/:id/comissao', async (req, res, next) => {
  try {
    const id = pInt(req.params.id);
    const bps = parsePercentToBps(req.body.comissao);
    if (bps === null || bps >= 10000) throw new Error('Comissão inválida.');
    // Para preposto, tambem atualiza o total padrao do cliente (se enviado).
    const totalRaw = parsePercentToBps(req.body.comissao_total);
    if (totalRaw !== null) {
      if (totalRaw >= 10000) throw new Error('Comissão total inválida.');
      if (totalRaw < bps) throw new Error('A comissão total não pode ser menor que a fatia do preposto.');
      await db.query("UPDATE usuarios SET comissao_bps = $2, comissao_total_bps = $3 WHERE id = $1 AND papel = 'representante'", [id, bps, totalRaw]);
    } else {
      await db.query("UPDATE usuarios SET comissao_bps = $2 WHERE id = $1 AND papel = 'representante'", [id, bps]);
    }
    res.redirect('/admin/representantes?cadastro=1&rep=' + id + '&ok=' + encodeURIComponent('Comissão padrão atualizada (vale para novos pedidos).'));
  } catch (e) { res.redirect('/admin/representantes?cadastro=1&erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/funcionarios/:id/taxa', async (req, res, next) => {
  try {
    const taxa = parsePrecoToCentavos(req.body.taxa);
    if (taxa === null) throw new Error('Taxa inválida.');
    await db.query("UPDATE usuarios SET taxa_etiqueta_centavos = $2 WHERE id = $1 AND papel = 'funcionario'", [pInt(req.params.id), taxa]);
    res.redirect('/admin/funcionarios?cadastro=1&func=' + req.params.id + '&ok=' + encodeURIComponent('Taxa atualizada (vale para novos pedidos).'));
  } catch (e) { res.redirect('/admin/funcionarios?cadastro=1&erro=' + encodeURIComponent(msgErro(e))); }
});

// ===================== FUNCIONARIOS =====================
router.get('/funcionarios', (req, res, next) => telaRepasses('funcionario', req, res, next));
router.post('/funcionarios', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim(), login = (req.body.login || '').trim(), senha = req.body.senha || '';
    const taxa = parsePrecoToCentavos(req.body.taxa);
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    if (taxa === null) throw new Error('Informe a taxa por etiqueta (R$).');
    const ins = await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel, taxa_etiqueta_centavos) VALUES ($1,$2,$3,$4,$5) RETURNING id', [nome, login, await bcrypt.hash(senha, 10), 'funcionario', taxa]);
    res.redirect('/admin/funcionarios?func=' + ins.rows[0].id + '&ok=' + encodeURIComponent('Funcionário cadastrado.'));
  } catch (e) { res.redirect('/admin/funcionarios?cadastro=1&erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/funcionarios/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE usuarios SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/funcionarios?cadastro=1&func=' + req.params.id); } catch (e) { next(e); }
});

// ===================== PRODUTOS =====================
router.get('/produtos', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.nome, p.sku, p.descricao, p.peso_gramas, p.medidas, p.ativo, p.saldo, p.reservado, p.custo_centavos, p.lucro_centavos, p.lucro_tipo, p.lucro_bps, p.rep_usuario_id, p.func_usuario_id,
              to_char(p.criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS criado_iso, to_char(p.criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS criado_br,
              (SELECT count(*) FROM itens i WHERE i.produto_id = p.id AND i.ativo)::int AS precos
       FROM produtos p ORDER BY p.nome`
    );
    const ref = await refCustos();
    const cores = await db.query('SELECT id, produto_id, nome, sku, saldo, reservado FROM produto_cores ORDER BY produto_id, ordem, id');
    const coresMap = new Map();
    for (const c of cores.rows) {
      if (!coresMap.has(c.produto_id)) coresMap.set(c.produto_id, []);
      coresMap.get(c.produto_id).push(c);
    }
    const imgMap = await imagens.listarPorProdutos(r.rows.map((p) => p.id));
    const produtos = r.rows.map((p) => ({ ...comCustos(p, ref), cores: (coresMap.get(p.id) || []).map((c) => ({ ...c, sku: skuCor(p.sku, c) })), imagens: imgMap.get(p.id) || [] }));
    const nfBps = await config.nfBps(db);
    res.render('admin/produtos', { produtos, ref, motivos: estoque.MOTIVOS, ativo: 'produtos', nfBps, erro: req.query.erro || null, ok: req.query.ok || null, formatBRL, formatPercent, pesoTxt });
  } catch (e) { next(e); }
});
// Taxa do imposto da nota fiscal (vale para todos os produtos) - so o admin completo define.
router.post('/config/nf', exigeAdminFull, async (req, res) => {
  try {
    const bps = parsePercentToBps(req.body.imposto);
    if (bps === null || bps < 0 || bps >= 100000) throw new Error('Informe o imposto em % (ex.: 10).');
    await config.setNfBps(db, bps);
    res.redirect('/admin/produtos?ok=' + encodeURIComponent('Imposto da nota fiscal salvo: ' + formatPercent(bps) + '.'));
  } catch (e) { res.redirect('/admin/produtos?erro=' + encodeURIComponent(e.message || 'Falha ao salvar o imposto.')); }
});
router.post('/produtos', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim();
    if (!nome) throw new Error('Informe o nome do produto.');
    const pm = parsePesoMedidas(req.body);
    const ins = await db.query('INSERT INTO produtos (nome, descricao, peso_gramas, medidas) VALUES ($1,$2,$3,$4) RETURNING id', [nome, (req.body.descricao || '').trim() || null, pm.peso, pm.medidas]);
    // Cores iniciais: "Branco (SKU123), Preto (SKU124)" -> SKU da cor entre parenteses
    const cores = parseCores(req.body.cores);
    for (let i = 0; i < cores.length; i++) {
      await db.query('INSERT INTO produto_cores (produto_id, nome, sku, ordem) VALUES ($1,$2,$3,$4) ON CONFLICT (produto_id, nome) DO NOTHING', [ins.rows[0].id, cores[i].nome, cores[i].sku, i]);
    }
    res.redirect('/admin/produtos');
  } catch (e) { res.redirect('/admin/produtos?erro=' + encodeURIComponent(msgErro(e))); }
});
// Peso em kg ("12,5") -> gramas; medidas texto livre (ex.: "120 x 45 x 80 cm").
function parsePesoMedidas(b) {
  const pesoTxt = (b.peso || '').toString().trim().replace(',', '.');
  const kg = pesoTxt === '' ? null : Number(pesoTxt);
  const peso = (kg === null || !isFinite(kg) || kg < 0) ? null : Math.round(kg * 1000);
  const medidas = (b.medidas || '').toString().trim().slice(0, 80) || null;
  return { peso, medidas };
}
function pesoTxt(g) { if (g === null || g === undefined) return ''; return (Number(g) / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' kg'; }
// Imagens do produto (upload multiplo e remocao; resposta JSON com a lista atual)
router.post('/produtos/:id/imagens', (req, res, next) => imagens.upload.array('imagens', imagens.MAX_POR_PRODUTO)(req, res, (err) => err ? responderErro(req, res, new Error(err.code === 'LIMIT_FILE_SIZE' ? 'Imagem acima de 6 MB.' : err.message), '/admin/produtos') : next()), async (req, res) => {
  try { responder(req, res, { imagens: await imagens.adicionar(pInt(req.params.id), req.files) }, '/admin/produtos'); } catch (e) { responderErro(req, res, e, '/admin/produtos'); }
});
router.post('/produtos/:id/imagens/:img/excluir', async (req, res) => {
  try { responder(req, res, { imagens: await imagens.remover(pInt(req.params.id), pInt(req.params.img)) }, '/admin/produtos'); } catch (e) { responderErro(req, res, e, '/admin/produtos'); }
});
// Peso e medidas (edicao inline)
router.post('/produtos/:id/dados', async (req, res, next) => {
  try {
    const pm = parsePesoMedidas(req.body);
    await db.query('UPDATE produtos SET peso_gramas = $2, medidas = $3 WHERE id = $1', [pInt(req.params.id), pm.peso, pm.medidas]);
    responder(req, res, { obs: [pesoTxt(pm.peso), pm.medidas].filter(Boolean).join(' · ') }, '/admin/produtos');
  } catch (e) { responderErro(req, res, e, '/admin/produtos'); }
});
function normSku(v) { const s = (v || '').toString().trim().toUpperCase().replace(/[^A-Z0-9\-_.\/]/g, '').slice(0, 40); return s || null; }
function parseCores(txt) {
  return (txt || '').toString().split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    const nome = (m ? m[1] : s).trim().slice(0, 40);
    const sku = m ? normSku(m[2]) : null;
    return { nome, sku };
  }).filter((c) => c.nome);
}
// Cores do produto (cada cor com seu SKU completo)
router.post('/produtos/:id/cores', async (req, res, next) => {
  try {
    const pid = pInt(req.params.id);
    const nome = (req.body.nome || '').toString().trim().slice(0, 40);
    if (!nome) throw new Error('Informe o nome da cor.');
    const ord = await db.query('SELECT COALESCE(max(ordem), -1) + 1 AS o FROM produto_cores WHERE produto_id = $1', [pid]);
    await db.query('INSERT INTO produto_cores (produto_id, nome, sku, ordem) VALUES ($1,$2,$3,$4)', [pid, nome, normSku(req.body.sku), ord.rows[0].o]);
    { const pn = await db.query('SELECT nome FROM produtos WHERE id = $1', [pid]); if (pn.rowCount) await novidades.registrar(db, { tipo: 'cor', produtoId: pid, titulo: pn.rows[0].nome + ' · cor nova: ' + nome, detalhe: normSku(req.body.sku) ? 'SKU ' + normSku(req.body.sku) : null }); }
    responder(req, res, { reload: true }, '/admin/produtos');
  } catch (e) { if (e && e.code === '23505') e = new Error('Essa cor já existe neste produto.'); responderErro(req, res, e, '/admin/produtos'); }
});
// Importa o catalogo de data/catalogo-produtos.json: cria produtos que nao existem (pelo nome),
// atualiza custo e descricao dos existentes e acrescenta cores que faltam. Nao apaga nada.
router.post('/produtos/importar', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const arq = require('path').join(__dirname, '..', '..', 'data', 'catalogo-produtos.json');
    const cat = JSON.parse(require('fs').readFileSync(arq, 'utf8'));
    let criados = 0, atualizados = 0, coresNovas = 0;
    await client.query('BEGIN');
    for (const p of cat.produtos) {
      const nome = String(p.nome || '').trim();
      if (!nome) continue;
      const custo = p.custo === null || p.custo === undefined || p.custo === '' ? null : parsePrecoToCentavos(p.custo);
      const ex = await client.query('SELECT id FROM produtos WHERE upper(nome) = upper($1) LIMIT 1', [nome]);
      let pid;
      if (ex.rowCount) {
        pid = ex.rows[0].id;
        await client.query('UPDATE produtos SET descricao = COALESCE($2, descricao), custo_centavos = COALESCE($3, custo_centavos) WHERE id = $1', [pid, p.descricao || null, custo]);
        atualizados++;
      } else {
        const ins = await client.query('INSERT INTO produtos (nome, descricao, custo_centavos) VALUES ($1,$2,$3) RETURNING id', [nome, p.descricao || null, custo]);
        pid = ins.rows[0].id; criados++;
        if (custo !== null) { const cs = Array.isArray(p.cores) ? p.cores : []; await novidades.registrar(client, { tipo: 'produto', produtoId: pid, titulo: nome + ' liberado', detalhe: (p.descricao || '') + (cs.length ? ' · ' + cs.map((c) => (c && typeof c === 'object') ? c.nome : c).join(', ') : '') }); }
      }
      // cores: "Nome" ou { nome, sku } (SKU da Shopee / marketplace)
      const cores = Array.isArray(p.cores) ? p.cores : [];
      for (let i = 0; i < cores.length; i++) {
        const c = cores[i];
        const cn = String((c && typeof c === 'object') ? c.nome : c || '').trim();
        const sku = (c && typeof c === 'object' && c.sku) ? normSku(c.sku) : null;
        if (!cn) continue;
        const r = await client.query(
          `INSERT INTO produto_cores (produto_id, nome, sku, ordem)
           SELECT $1, $2, $4, $3 WHERE NOT EXISTS (SELECT 1 FROM produto_cores c WHERE c.produto_id = $1 AND upper(c.nome) = upper($2))`,
          [pid, cn, i, sku]
        );
        coresNovas += r.rowCount;
        if (r.rowCount === 0 && sku) await client.query('UPDATE produto_cores SET sku = COALESCE(sku, $3) WHERE produto_id = $1 AND upper(nome) = upper($2)', [pid, cn, sku]);
      }
    }
    await client.query('COMMIT');
    res.redirect('/admin/produtos?ok=' + encodeURIComponent('Catálogo importado: ' + criados + ' produto(s) criados, ' + atualizados + ' atualizados, ' + coresNovas + ' cor(es) adicionadas.'));
  } catch (e) { await client.query('ROLLBACK'); console.error('Erro ao importar catalogo:', e); res.redirect('/admin/produtos?erro=' + encodeURIComponent('Falha ao importar: ' + (e.message || ''))); } finally { client.release(); }
});
// Custo, lucro desejado e % do representante do produto (para o preco sugerido).
router.post('/produtos/:id/custos', async (req, res, next) => {
  try {
    const custoTxt = (req.body.custo || '').toString().trim(), lucroTxt = (req.body.lucro || '').toString().trim();
    const lucroTipo = req.body.lucro_tipo === 'percentual' ? 'percentual' : 'valor';
    const custo = custoTxt === '' ? null : parsePrecoToCentavos(custoTxt);
    if (custoTxt !== '' && custo === null) throw new Error('O custo deve ser um valor em R$ (ex.: 40,00).');
    let lucro = null, lucroBps = null;
    if (lucroTipo === 'percentual') {
      lucroBps = lucroTxt === '' ? null : parsePercentToBps(lucroTxt);
      if (lucroTxt !== '' && lucroBps === null) throw new Error('O lucro em % deve ser um número (ex.: 25).');
    } else {
      lucro = lucroTxt === '' ? null : parsePrecoToCentavos(lucroTxt);
      if (lucroTxt !== '' && lucro === null) throw new Error('O lucro deve ser um valor em R$ (ex.: 20,00).');
    }
    // quem recebe: validados contra o cadastro (papel certo e ativo)
    const repId = pInt(req.body.rep_id), funcId = pInt(req.body.func_id);
    const okRep = repId ? await db.query("SELECT COALESCE(comissao_bps, 0)::int AS bps FROM usuarios WHERE id = $1 AND papel = 'representante'", [repId]) : { rowCount: 0, rows: [] };
    const okFunc = funcId ? await db.query("SELECT 1 FROM usuarios WHERE id = $1 AND papel = 'funcionario'", [funcId]) : { rowCount: 0 };
    if (lucroBps !== null && (okRep.rowCount ? okRep.rows[0].bps : 0) + lucroBps >= 10000) throw new Error('Lucro + representante precisam ficar abaixo de 100%.');
    const antes = await db.query('SELECT nome, custo_centavos FROM produtos WHERE id = $1', [pInt(req.params.id)]);
    await db.query('UPDATE produtos SET custo_centavos = $2, lucro_centavos = $3, rep_usuario_id = $4, func_usuario_id = $5, lucro_tipo = $6, lucro_bps = $7 WHERE id = $1',
      [pInt(req.params.id), custo, lucro, okRep.rowCount ? repId : null, okFunc.rowCount ? funcId : null, lucroTipo, lucroBps]);
    // produto que ganhou custo pela primeira vez passa a ter preco sugerido: fica liberado para os clientes
    if (antes.rowCount && antes.rows[0].custo_centavos === null && custo !== null) {
      await novidades.registrar(db, { tipo: 'produto', produtoId: pInt(req.params.id), titulo: antes.rows[0].nome + ' liberado', detalhe: 'já disponível para envio' });
    }
    if (isAjax(req)) {
      // devolve o quadro recalculado para a tela atualizar sem recarregar
      const ref = await refCustos();
      const p = await db.query('SELECT custo_centavos, lucro_centavos, lucro_tipo, lucro_bps, rep_usuario_id, func_usuario_id FROM produtos WHERE id = $1', [pInt(req.params.id)]);
      const pc = comCustos(p.rows[0], ref);
      return res.json({ ok: true, custo: pc.custo_centavos !== null ? formatBRL(pc.custo_centavos) : '—', lucro: pc.lucro_alvo !== null ? formatBRL(pc.lucro_alvo) : '—',
        lucroRot: pc.lucro_pct && pc.lucro_bps !== null ? '· ' + formatPercent(pc.lucro_bps) + ' da venda' : '',
        func: formatBRL(pc.func_centavos), funcNome: pc.func ? pc.func.nome : 'ninguém', repNome: pc.rep ? pc.rep.nome : 'ninguém', repPct: formatPercent(pc.rep_bps_efetivo),
        comissao: pc.sugerido !== null ? formatBRL(Math.round(pc.sugerido * pc.rep_bps_efetivo / 10000)) : '—', sugerido: pc.sugerido !== null ? formatBRL(pc.sugerido) : '—' });
    }
    res.redirect('/admin/produtos?ok=' + encodeURIComponent('Custos atualizados.'));
  } catch (e) { responderErro(req, res, e, '/admin/produtos'); }
});
// Lancamento de estoque (entrada, ajuste ou saida manual) numa cor ou no produto (cor unica).
router.post('/produtos/:id/estoque', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const pid = pInt(req.params.id), corId = pInt(req.body.cor_id);
    let qtd = pInt(req.body.quantidade);
    const motivo = estoque.MOTIVOS.includes(req.body.motivo) ? req.body.motivo : 'Ajuste';
    if (qtd === null || qtd === 0) throw new Error('Informe a quantidade (ex.: 10 para entrada, -3 para saída).');
    if (motivo === 'Saída manual' && qtd > 0) qtd = -qtd;
    if (motivo === 'Entrada' && qtd < 0) qtd = -qtd;
    await client.query('BEGIN');
    const r = await estoque.movimentar(client, { produtoId: pid, corId, quantidade: qtd, motivo, observacao: (req.body.observacao || '').toString().trim().slice(0, 200) || null, usuarioId: req.session.user.id });
    await client.query('COMMIT');
    if (r === null) throw new Error('Produto ou cor não encontrados.');
    responder(req, res, { saldo: r.saldo, reservado: r.reservado, disponivel: r.disponivel, msg: 'Estoque atualizado: disponível ' + r.disponivel + '.' }, '/admin/produtos?ok=' + encodeURIComponent('Estoque atualizado: disponível ' + r.disponivel + '.'));
  } catch (e) { await client.query('ROLLBACK'); responderErro(req, res, e, '/admin/produtos'); } finally { client.release(); }
});
// Historico de movimentos
router.get('/estoque', async (req, res, next) => {
  try {
    const produtoId = pInt(req.query.produto);
    const produtos = await estoque.saldosTodos();
    const movs = await estoque.historico({ produtoId });
    res.render('admin/estoque', { ativo: 'estoque', produtos, movs, produtoId, formatDateTime });
  } catch (e) { next(e); }
});
// Editar o SKU de uma cor
router.post('/produtos/:id/cores/:cid/sku', async (req, res, next) => {
  try { const sku = normSku(req.body.sku); await db.query('UPDATE produto_cores SET sku = $3 WHERE id = $1 AND produto_id = $2', [pInt(req.params.cid), pInt(req.params.id), sku]); responder(req, res, { sku: sku || '' }, '/admin/produtos'); } catch (e) { next(e); }
});
router.post('/produtos/:id/cores/:cid/remover', async (req, res, next) => {
  try { await db.query('DELETE FROM produto_cores WHERE id = $1 AND produto_id = $2', [pInt(req.params.cid), pInt(req.params.id)]); responder(req, res, { reload: true }, '/admin/produtos'); } catch (e) { next(e); }
});
router.post('/produtos/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE produtos SET ativo = NOT ativo WHERE id = $1', [req.params.id]); responder(req, res, { reload: true }, '/admin/produtos'); } catch (e) { next(e); }
});
// Excluir produto do catalogo: remove tambem os precos por cliente ligados a ele.
// Pedidos ja feitos nao mudam (linhas guardam nome e preco; item_id vira NULL).
router.post('/produtos/:id/excluir', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const id = pInt(req.params.id);
    await client.query('BEGIN');
    const p = await client.query('SELECT nome FROM produtos WHERE id = $1', [id]);
    if (p.rowCount === 0) { await client.query('ROLLBACK'); return res.redirect('/admin/produtos?erro=' + encodeURIComponent('Produto não encontrado.')); }
    const it = await client.query('DELETE FROM itens WHERE produto_id = $1', [id]);
    await client.query('DELETE FROM produtos WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.redirect('/admin/produtos?ok=' + encodeURIComponent('Produto "' + p.rows[0].nome + '" excluído' + (it.rowCount ? ' junto com ' + it.rowCount + ' preço(s) por cliente.' : '.')));
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

// ===================== PRECOS POR CLIENTE =====================
router.get('/precos', async (req, res, next) => {
  try {
    const clientes = await db.query('SELECT id, nome FROM clientes WHERE ativo = TRUE ORDER BY nome');
    const ref = await refCustos();
    const prodRes = await db.query('SELECT id, nome, custo_centavos, lucro_centavos, lucro_tipo, lucro_bps, rep_usuario_id, func_usuario_id FROM produtos WHERE ativo = TRUE ORDER BY nome');
    const produtos = { rows: prodRes.rows.map((p) => comCustos(p, ref)) };
    let clienteId = pInt(req.query.cliente);
    if (!clienteId && clientes.rowCount > 0) clienteId = clientes.rows[0].id;
    let itens = { rows: [] }, clienteNome = '';
    if (clienteId) {
      itens = await db.query(
        `SELECT i.id, i.nome, i.preco_centavos, i.promo_tipo, i.promo_valor, i.promo_rep_bps, i.produto_id,
                to_char(i.promo_inicio, 'YYYY-MM-DD') AS promo_inicio, to_char(i.promo_fim, 'YYYY-MM-DD') AS promo_fim,
                p.custo_centavos, p.lucro_centavos, p.lucro_tipo, p.lucro_bps, p.rep_usuario_id, p.func_usuario_id
         FROM itens i LEFT JOIN produtos p ON p.id = i.produto_id
         WHERE i.cliente_id = $1 AND i.ativo = TRUE AND i.negociado = TRUE ORDER BY i.nome`, [clienteId]
      );
      const cn = await db.query('SELECT nome FROM clientes WHERE id = $1', [clienteId]);
      clienteNome = cn.rowCount ? cn.rows[0].nome : '';
    }
    // % normal do representante para este cliente (vale fora da campanha): o do cadastro do cliente,
    // ou, na falta, o % padrao do representante vinculado.
    let clienteRepBps = 0;
    if (clienteId) {
      const cr = await db.query("SELECT c.comissao_total_bps, u.comissao_bps AS u_bps FROM clientes c LEFT JOIN usuarios u ON u.id = c.representante_id AND u.papel = 'representante' WHERE c.id = $1", [clienteId]);
      if (cr.rowCount) clienteRepBps = Number(cr.rows[0].comissao_total_bps != null ? cr.rows[0].comissao_total_bps : (cr.rows[0].u_bps || 0)) || 0;
    }
    const hoje = hojeISO();
    const lista = itens.rows.map((i) => {
      const ef = precoEfetivo(i, hoje);
      // promo cadastrada mas fora do periodo (agendada ou encerrada)
      let promoEstado = null;
      if (i.promo_tipo && !ef.promo) promoEstado = (i.promo_inicio && i.promo_inicio > hoje) ? 'agendada' : 'encerrada';
      // lucro por unidade com o preco negociado (e com a promocao, se ativa)
      const pc = comCustos(i, ref);
      // Durante a campanha a comissao do rep usa o % da campanha (se definido); senao, o % do produto.
      const repPromoBps = (ef.promo && i.promo_rep_bps !== null && i.promo_rep_bps !== undefined) ? Number(i.promo_rep_bps) : pc.rep_bps_efetivo;
      const lucroInfo = pc.temCustos ? {
        sugerido: pc.sugerido,
        lucro: lucroCom(i.preco_centavos, { custo_centavos: pc.custo_centavos, rep_bps: pc.rep_bps_efetivo }, pc.func_centavos),
        lucroPromo: ef.promo ? lucroCom(ef.preco_centavos, { custo_centavos: pc.custo_centavos, rep_bps: repPromoBps }, pc.func_centavos) : null,
        lucroAlvo: Number(pc.lucro_alvo || 0),
        diffSugerido: pc.sugerido !== null ? i.preco_centavos - pc.sugerido : null,
      } : null;
      return { ...i, efetivo: ef, promoEstado, lucroInfo,
        promo_rep_txt: (i.promo_rep_bps !== null && i.promo_rep_bps !== undefined) ? formatPercent(i.promo_rep_bps).replace('%', '') : '',
        promo_valor_txt: i.promo_tipo === 'percentual' ? formatPercent(i.promo_valor).replace('%', '') : (i.promo_valor !== null ? (i.promo_valor / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '') };
    });
    // Promoções em andamento: todas as promoções ativas hoje, de todos os clientes (visão geral no topo da tela).
    const hojeD = new Date(hoje + 'T00:00:00');
    const promoAll = await db.query(
      `SELECT i.id, i.nome, i.preco_centavos, i.promo_tipo, i.promo_valor, c.id AS cliente_id, c.nome AS cliente_nome,
              to_char(i.promo_inicio, 'YYYY-MM-DD') AS promo_inicio, to_char(i.promo_fim, 'YYYY-MM-DD') AS promo_fim
       FROM itens i JOIN clientes c ON c.id = i.cliente_id
       WHERE i.ativo = TRUE AND i.negociado = TRUE AND i.promo_tipo IS NOT NULL
       ORDER BY i.promo_fim NULLS LAST, c.nome, i.nome`);
    const promocoes = [];
    for (const i of promoAll.rows) {
      const ef = precoEfetivo(i, hoje);
      if (!ef.promo) continue; // mostra só as que estão valendo hoje (ignora agendadas/encerradas)
      const descBps = i.preco_centavos > 0 ? Math.round((i.preco_centavos - ef.preco_centavos) * 10000 / i.preco_centavos) : 0;
      let dias = null;
      if (i.promo_fim) dias = Math.round((new Date(i.promo_fim + 'T00:00:00') - hojeD) / 86400000);
      promocoes.push({ id: i.id, nome: i.nome, cliente_id: i.cliente_id, cliente_nome: i.cliente_nome,
        de: i.preco_centavos, por: ef.preco_centavos, desc_bps: descBps, fim: i.promo_fim, dias });
    }
    res.render('admin/precos', { clientes: clientes.rows, produtos: produtos.rows, itens: lista, promocoes, clienteId, clienteNome, clienteRepBps, ref, ativo: 'precos', erro: req.query.erro || null, ok: req.query.ok || null, formatBRL, formatPercent, brDate });
  } catch (e) { next(e); }
});
router.post('/precos', async (req, res, next) => {
  try {
    const clienteId = pInt(req.body.cliente_id), produtoId = pInt(req.body.produto_id), preco = parsePrecoToCentavos(req.body.preco);
    if (!clienteId || !produtoId) throw new Error('Escolha cliente e produto.');
    if (preco === null) throw new Error('Informe o preço negociado.');
    const prod = await db.query('SELECT nome FROM produtos WHERE id = $1', [produtoId]);
    if (prod.rowCount === 0) throw new Error('Produto inválido.');
    // ja existe vinculo (negociacao anterior ou vinculo automatico do aceite)? vira negociacao
    const ex = await db.query('SELECT id FROM itens WHERE cliente_id = $1 AND produto_id = $2 ORDER BY ativo DESC, id DESC LIMIT 1', [clienteId, produtoId]);
    if (ex.rowCount) {
      await db.query('UPDATE itens SET preco_centavos = $2, nome = $3, negociado = TRUE, ativo = TRUE WHERE id = $1', [ex.rows[0].id, preco, prod.rows[0].nome]);
    } else {
      await db.query('INSERT INTO itens (cliente_id, produto_id, nome, preco_centavos, negociado) VALUES ($1,$2,$3,$4,TRUE)', [clienteId, produtoId, prod.rows[0].nome, preco]);
    }
    await novidades.registrar(db, { tipo: 'negociado', clienteId, produtoId, titulo: prod.rows[0].nome + ' com preço negociado para você', detalhe: formatBRL(preco) + ' por unidade, válido para todas as cores' });
    res.redirect('/admin/precos?cliente=' + clienteId + '&ok=' + encodeURIComponent('Negociação salva: substitui o preço sugerido para este cliente.'));
  } catch (e) { const cid = pInt(req.body.cliente_id) || ''; res.redirect('/admin/precos?cliente=' + cid + '&erro=' + encodeURIComponent(msgErro(e))); }
});
// Promocao no preco negociado: tipo 'valor' (preco promocional em R$) ou 'percentual' (% de desconto), com periodo.
router.post('/precos/:id/promo', async (req, res, next) => {
  const id = pInt(req.params.id);
  const cur = await db.query('SELECT cliente_id, preco_centavos FROM itens WHERE id = $1', [id]).catch(() => ({ rowCount: 0 }));
  const cid = cur.rowCount ? cur.rows[0].cliente_id : '';
  try {
    if (!cur.rowCount) throw new Error('Preço não encontrado.');
    const tipo = req.body.tipo === 'percentual' ? 'percentual' : 'valor';
    const valor = tipo === 'percentual' ? parsePercentToBps(req.body.valor) : parsePrecoToCentavos(req.body.valor);
    if (valor === null || valor <= 0) throw new Error(tipo === 'percentual' ? 'Informe o percentual de desconto.' : 'Informe o preço promocional.');
    if (tipo === 'percentual' && valor >= 10000) throw new Error('Desconto deve ser menor que 100%.');
    if (tipo === 'valor' && valor >= cur.rows[0].preco_centavos) throw new Error('O preço promocional deve ser menor que o preço negociado.');
    const ini = /^\d{4}-\d{2}-\d{2}$/.test(req.body.inicio || '') ? req.body.inicio : null;
    const fim = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fim || '') ? req.body.fim : null;
    if (!fim) throw new Error('Informe até quando vale a promoção.');
    if (ini && fim < ini) throw new Error('A data final é anterior à inicial.');
    // % do representante durante a campanha (opcional). Vazio = mantem o % normal do cadastro.
    const repTxt = (req.body.rep_percent || '').toString().trim();
    let repBps = null;
    if (repTxt !== '') {
      repBps = parsePercentToBps(repTxt);
      if (repBps === null || repBps < 0 || repBps >= 10000) throw new Error('% do representante na campanha inválida (0 a 99,99%).');
    }
    await db.query('UPDATE itens SET promo_tipo = $2, promo_valor = $3, promo_inicio = $4, promo_fim = $5, promo_rep_bps = $6 WHERE id = $1', [id, tipo, valor, ini, fim, repBps]);
    {
      const it = await db.query('SELECT nome, produto_id, preco_centavos FROM itens WHERE id = $1', [id]);
      const novo = tipo === 'percentual' ? Math.round(it.rows[0].preco_centavos * (10000 - valor) / 10000) : valor;
      await novidades.registrar(db, { tipo: 'promo', clienteId: cid, produtoId: it.rows[0].produto_id, titulo: it.rows[0].nome + ' em promoção' + (fim ? ' até ' + brDate(fim) : ''), detalhe: (tipo === 'percentual' ? formatPercent(valor) + ' off · ' : '') + 'de ' + formatBRL(it.rows[0].preco_centavos) + ' por ' + formatBRL(novo) });
    }
    res.redirect('/admin/precos?cliente=' + cid + '&ok=' + encodeURIComponent('Promoção aplicada.'));
  } catch (e) { res.redirect('/admin/precos?cliente=' + cid + '&erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/precos/:id/promo/remover', async (req, res, next) => {
  try {
    const it = await db.query('UPDATE itens SET promo_tipo = NULL, promo_valor = NULL, promo_inicio = NULL, promo_fim = NULL, promo_rep_bps = NULL WHERE id = $1 RETURNING cliente_id', [pInt(req.params.id)]);
    // "voltar" = cliente que está aberto na tela (ao encerrar pelo card "Promoções em andamento"); senão, o dono da promoção.
    const voltar = pInt(req.body.voltar) || (it.rowCount ? it.rows[0].cliente_id : '');
    res.redirect('/admin/precos?cliente=' + voltar + '&ok=' + encodeURIComponent('Promoção encerrada.'));
  } catch (e) { next(e); }
});
router.post('/precos/:id/remove', async (req, res, next) => {
  try {
    // remover a negociacao: o produto volta ao preco sugerido (o vinculo fica, sem negociacao, para o historico)
    const it = await db.query('UPDATE itens SET negociado = FALSE, promo_tipo = NULL, promo_valor = NULL, promo_inicio = NULL, promo_fim = NULL, promo_rep_bps = NULL WHERE id = $1 RETURNING cliente_id', [req.params.id]);
    res.redirect('/admin/precos?cliente=' + (it.rowCount ? it.rows[0].cliente_id : ''));
  } catch (e) { next(e); }
});

module.exports = router;
