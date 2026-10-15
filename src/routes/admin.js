'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { exigeAdmin } = require('../auth');
const { enviarEtiquetas } = require('../etiquetas');
const financeiro = require('../financeiro');
const estoque = require('../estoque');
const repasses = require('../repasses');

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
  precoSugerido, lucroCom,
} = require('../util');

// Representantes (comissao %) e funcionarios (taxa por etiqueta) ativos, para o calculo de preco.
async function refCustos() {
  const reps = await db.query("SELECT id, nome, COALESCE(comissao_bps, 0)::int AS bps FROM usuarios WHERE papel = 'representante' AND ativo = TRUE ORDER BY nome");
  const funcs = await db.query("SELECT id, nome, COALESCE(taxa_etiqueta_centavos, 0)::int AS taxa FROM usuarios WHERE papel = 'funcionario' AND ativo = TRUE ORDER BY nome");
  return { reps: reps.rows, funcs: funcs.rows };
}
// Anexa ao produto quem foi escolhido (ou ninguem), as taxas lidas do cadastro e o preco sugerido.
function comCustos(p, ref) {
  const rep = ref.reps.find((r) => r.id === p.rep_usuario_id) || null;
  const func = ref.funcs.find((f) => f.id === p.func_usuario_id) || null;
  const repBps = rep ? rep.bps : 0;
  const funcCentavos = func ? func.taxa : 0;
  const base = { custo_centavos: p.custo_centavos, lucro_centavos: p.lucro_centavos, rep_bps: repBps };
  const sugerido = precoSugerido(base, funcCentavos);
  return { ...p, rep, func, rep_bps_efetivo: repBps, func_centavos: funcCentavos, sugerido, temCustos: p.custo_centavos !== null || p.lucro_centavos !== null };
}

const router = express.Router();
router.use(exigeAdmin);

function pInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
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
      `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas,
              p.aceite_em, p.etiquetas_expira_em, p.despachado_em, p.comissao_centavos,
              c.nome AS cliente_nome, u.nome AS rep_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios u ON u.id = p.representante_id ORDER BY p.id DESC`
    );
    const fr = await funcRef();
    const pedidos = r.rows.map((p) => ({
      ...p, expirado: etiquetasExpiradas(p.etiquetas_expira_em), horas: horasRestantes(p.etiquetas_expira_em),
      taxa_func_centavos: fr ? fr.taxa_etiqueta_centavos * p.total_etiquetas : null,
    }));
    res.render('admin/pedidos', { pedidos, funcRef: fr, ok: req.query.ok || null, formatBRL, formatDateTime });
  } catch (e) { next(e); }
});

router.get('/pedido/:id', async (req, res, next) => {
  try {
    const pr = await db.query(
      `SELECT p.*, c.nome AS cliente_nome, c.email AS cliente_email, u.nome AS rep_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios u ON u.id = p.representante_id WHERE p.id = $1`, [req.params.id]
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
    res.render('admin/pedido', {
      pedido, linhas: linhas.rows, reps: reps.rows, funcs: funcs.rows, funcRef: fr,
      taxaFuncCentavos: fr ? fr.taxa_etiqueta_centavos * pedido.total_etiquetas : null,
      passos: andamentoDisplay(pedido),
      etiquetas: etqs.rows, etqDespachadas, etqTotal: etqs.rowCount,
      expirado: etiquetasExpiradas(pedido.etiquetas_expira_em), horas: horasRestantes(pedido.etiquetas_expira_em),
      erro: req.query.erro || null,
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
      await db.query('UPDATE pedidos SET representante_id = NULL, comissao_bps = NULL, comissao_centavos = 0 WHERE id = $1', [req.params.id]);
      return res.redirect('/admin/pedido/' + req.params.id);
    }
    const rep = await db.query("SELECT comissao_bps FROM usuarios WHERE id = $1 AND papel = 'representante'", [repId]);
    if (rep.rowCount === 0) return res.redirect('/admin/pedido/' + req.params.id);
    let bps = parsePercentToBps(req.body.percent);
    if (bps === null) bps = rep.rows[0].comissao_bps || 0;
    await db.query('UPDATE pedidos SET representante_id = $1, comissao_bps = $2, comissao_centavos = $3 WHERE id = $4', [repId, bps, comissaoCentavos(total, bps), req.params.id]);
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
router.get('/clientes', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.nome, c.ativo, c.prazo_dias, c.limite_centavos, c.bloquear_vencido, u.login,
              (SELECT COALESCE(sum(f.valor_centavos), 0) FROM financeiro f WHERE f.cliente_id = c.id AND f.status = 'aberto')::int AS em_aberto,
              (SELECT count(*) FROM pedidos p WHERE p.cliente_id = c.id)::int AS pedidos,
              (SELECT count(*) FROM itens i WHERE i.cliente_id = c.id AND i.ativo) AS produtos
       FROM clientes c LEFT JOIN usuarios u ON u.cliente_id = c.id AND u.papel = 'cliente' ORDER BY c.nome`
    );
    res.render('admin/clientes', { clientes: r.rows, ativo: 'clientes', erro: req.query.erro || null, ok: req.query.ok || null, formatBRL });
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
    await client.query('BEGIN');
    const c = await client.query('INSERT INTO clientes (nome, email, prazo_dias, limite_centavos) VALUES ($1,$2,$3,$4) RETURNING id', [nome, email || null, prazo, limite]);
    await client.query('INSERT INTO usuarios (nome, login, senha_hash, papel, cliente_id) VALUES ($1,$2,$3,$4,$5)', [nome, login, await bcrypt.hash(senha, 10), 'cliente', c.rows[0].id]);
    await client.query('COMMIT');
    res.redirect('/admin/clientes');
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

// ===================== REPRESENTANTES =====================
router.get('/representantes', (req, res, next) => telaRepasses('representante', req, res, next));
// Repasses: marcar pago / reabrir / pagar todos liberados (tipo = representante | funcionario)
router.post('/repasses/:tipo/:pedidoId/pagar', async (req, res, next) => {
  const tipo = req.params.tipo === 'funcionario' ? 'funcionario' : 'representante';
  try {
    const data = /^\d{4}-\d{2}-\d{2}$/.test(req.body.pago_em || '') ? req.body.pago_em : hojeISO();
    const forma = repasses.FORMAS.includes(req.body.forma) ? req.body.forma : 'Outro';
    const p = await repasses.marcarPago(tipo, pInt(req.params.pedidoId), data, forma);
    res.redirect(voltarRepasses(tipo, req, { ok: 'Repasse do pedido ' + p.numero + ' (' + formatBRL(p.valor) + ') marcado como pago.' }));
  } catch (e) { res.redirect(voltarRepasses(tipo, req, { erro: e.message || 'Falha ao marcar.' })); }
});
router.post('/repasses/:tipo/:pedidoId/reabrir', async (req, res, next) => {
  const tipo = req.params.tipo === 'funcionario' ? 'funcionario' : 'representante';
  try { await repasses.reabrir(tipo, pInt(req.params.pedidoId)); res.redirect(voltarRepasses(tipo, req, { ok: 'Repasse reaberto.' })); }
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
    const ins = await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel, comissao_bps) VALUES ($1,$2,$3,$4,$5) RETURNING id', [nome, login, await bcrypt.hash(senha, 10), 'representante', bps]);
    res.redirect('/admin/representantes?rep=' + ins.rows[0].id + '&ok=' + encodeURIComponent('Representante cadastrado.'));
  } catch (e) { res.redirect('/admin/representantes?cadastro=1&erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/representantes/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE usuarios SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/representantes?cadastro=1&rep=' + req.params.id); } catch (e) { next(e); }
});
// Comissao padrao / taxa (edicao inline no painel de cadastro)
router.post('/representantes/:id/comissao', async (req, res, next) => {
  try {
    const bps = parsePercentToBps(req.body.comissao);
    if (bps === null || bps >= 10000) throw new Error('Comissão inválida.');
    await db.query("UPDATE usuarios SET comissao_bps = $2 WHERE id = $1 AND papel = 'representante'", [pInt(req.params.id), bps]);
    res.redirect('/admin/representantes?cadastro=1&rep=' + req.params.id + '&ok=' + encodeURIComponent('Comissão padrão atualizada (vale para novos pedidos).'));
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
      `SELECT p.id, p.nome, p.sku, p.descricao, p.ativo, p.saldo, p.reservado, p.custo_centavos, p.lucro_centavos, p.rep_usuario_id, p.func_usuario_id,
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
    const produtos = r.rows.map((p) => ({ ...comCustos(p, ref), cores: (coresMap.get(p.id) || []).map((c) => ({ ...c, sku: skuCor(p.sku, c) })) }));
    res.render('admin/produtos', { produtos, ref, motivos: estoque.MOTIVOS, ativo: 'produtos', erro: req.query.erro || null, ok: req.query.ok || null, formatBRL, formatPercent });
  } catch (e) { next(e); }
});
router.post('/produtos', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim();
    if (!nome) throw new Error('Informe o nome do produto.');
    const ins = await db.query('INSERT INTO produtos (nome, descricao) VALUES ($1,$2) RETURNING id', [nome, (req.body.descricao || '').trim() || null]);
    // Cores iniciais: "Branco (SKU123), Preto (SKU124)" -> SKU da cor entre parenteses
    const cores = parseCores(req.body.cores);
    for (let i = 0; i < cores.length; i++) {
      await db.query('INSERT INTO produto_cores (produto_id, nome, sku, ordem) VALUES ($1,$2,$3,$4) ON CONFLICT (produto_id, nome) DO NOTHING', [ins.rows[0].id, cores[i].nome, cores[i].sku, i]);
    }
    res.redirect('/admin/produtos');
  } catch (e) { res.redirect('/admin/produtos?erro=' + encodeURIComponent(msgErro(e))); }
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
    res.redirect('/admin/produtos');
  } catch (e) { res.redirect('/admin/produtos?erro=' + encodeURIComponent(e.code === '23505' ? 'Essa cor já existe neste produto.' : msgErro(e))); }
});
// Custo, lucro desejado e % do representante do produto (para o preco sugerido).
router.post('/produtos/:id/custos', async (req, res, next) => {
  try {
    const custoTxt = (req.body.custo || '').toString().trim(), lucroTxt = (req.body.lucro || '').toString().trim();
    const custo = custoTxt === '' ? null : parsePrecoToCentavos(custoTxt);
    const lucro = lucroTxt === '' ? null : parsePrecoToCentavos(lucroTxt);
    if ((custoTxt !== '' && custo === null) || (lucroTxt !== '' && lucro === null)) throw new Error('Custo e lucro devem ser valores em R$ (ex.: 40,00).');
    // quem recebe: validados contra o cadastro (papel certo e ativo)
    const repId = pInt(req.body.rep_id), funcId = pInt(req.body.func_id);
    const okRep = repId ? await db.query("SELECT 1 FROM usuarios WHERE id = $1 AND papel = 'representante'", [repId]) : { rowCount: 0 };
    const okFunc = funcId ? await db.query("SELECT 1 FROM usuarios WHERE id = $1 AND papel = 'funcionario'", [funcId]) : { rowCount: 0 };
    await db.query('UPDATE produtos SET custo_centavos = $2, lucro_centavos = $3, rep_usuario_id = $4, func_usuario_id = $5 WHERE id = $1',
      [pInt(req.params.id), custo, lucro, okRep.rowCount ? repId : null, okFunc.rowCount ? funcId : null]);
    res.redirect('/admin/produtos?ok=' + encodeURIComponent('Custos atualizados.'));
  } catch (e) { res.redirect('/admin/produtos?erro=' + encodeURIComponent(msgErro(e))); }
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
    const saldo = await estoque.movimentar(client, { produtoId: pid, corId, quantidade: qtd, motivo, observacao: (req.body.observacao || '').toString().trim().slice(0, 200) || null, usuarioId: req.session.user.id });
    await client.query('COMMIT');
    if (saldo === null) throw new Error('Produto ou cor não encontrados.');
    res.redirect('/admin/produtos?ok=' + encodeURIComponent('Estoque atualizado: saldo ' + saldo + '.'));
  } catch (e) { await client.query('ROLLBACK'); res.redirect('/admin/produtos?erro=' + encodeURIComponent(msgErro(e))); } finally { client.release(); }
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
  try { await db.query('UPDATE produto_cores SET sku = $3 WHERE id = $1 AND produto_id = $2', [pInt(req.params.cid), pInt(req.params.id), normSku(req.body.sku)]); res.redirect('/admin/produtos'); } catch (e) { next(e); }
});
router.post('/produtos/:id/cores/:cid/remover', async (req, res, next) => {
  try { await db.query('DELETE FROM produto_cores WHERE id = $1 AND produto_id = $2', [pInt(req.params.cid), pInt(req.params.id)]); res.redirect('/admin/produtos'); } catch (e) { next(e); }
});
router.post('/produtos/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE produtos SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/produtos'); } catch (e) { next(e); }
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
    const prodRes = await db.query('SELECT id, nome, custo_centavos, lucro_centavos, rep_usuario_id, func_usuario_id FROM produtos WHERE ativo = TRUE ORDER BY nome');
    const produtos = { rows: prodRes.rows.map((p) => comCustos(p, ref)) };
    let clienteId = pInt(req.query.cliente);
    if (!clienteId && clientes.rowCount > 0) clienteId = clientes.rows[0].id;
    let itens = { rows: [] }, clienteNome = '';
    if (clienteId) {
      itens = await db.query(
        `SELECT i.id, i.nome, i.preco_centavos, i.promo_tipo, i.promo_valor, i.produto_id,
                to_char(i.promo_inicio, 'YYYY-MM-DD') AS promo_inicio, to_char(i.promo_fim, 'YYYY-MM-DD') AS promo_fim,
                p.custo_centavos, p.lucro_centavos, p.rep_usuario_id, p.func_usuario_id
         FROM itens i LEFT JOIN produtos p ON p.id = i.produto_id
         WHERE i.cliente_id = $1 AND i.ativo = TRUE ORDER BY i.nome`, [clienteId]
      );
      const cn = await db.query('SELECT nome FROM clientes WHERE id = $1', [clienteId]);
      clienteNome = cn.rowCount ? cn.rows[0].nome : '';
    }
    const hoje = hojeISO();
    const lista = itens.rows.map((i) => {
      const ef = precoEfetivo(i, hoje);
      // promo cadastrada mas fora do periodo (agendada ou encerrada)
      let promoEstado = null;
      if (i.promo_tipo && !ef.promo) promoEstado = (i.promo_inicio && i.promo_inicio > hoje) ? 'agendada' : 'encerrada';
      // lucro por unidade com o preco negociado (e com a promocao, se ativa)
      const pc = comCustos(i, ref);
      const lucroInfo = pc.temCustos ? {
        sugerido: pc.sugerido,
        lucro: lucroCom(i.preco_centavos, { custo_centavos: pc.custo_centavos, rep_bps: pc.rep_bps_efetivo }, pc.func_centavos),
        lucroPromo: ef.promo ? lucroCom(ef.preco_centavos, { custo_centavos: pc.custo_centavos, rep_bps: pc.rep_bps_efetivo }, pc.func_centavos) : null,
        lucroAlvo: Number(i.lucro_centavos || 0),
        diffSugerido: pc.sugerido !== null ? i.preco_centavos - pc.sugerido : null,
      } : null;
      return { ...i, efetivo: ef, promoEstado, lucroInfo, promo_valor_txt: i.promo_tipo === 'percentual' ? formatPercent(i.promo_valor).replace('%', '') : (i.promo_valor !== null ? (i.promo_valor / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '') };
    });
    res.render('admin/precos', { clientes: clientes.rows, produtos: produtos.rows, itens: lista, clienteId, clienteNome, ref, ativo: 'precos', erro: req.query.erro || null, ok: req.query.ok || null, formatBRL, formatPercent, brDate });
  } catch (e) { next(e); }
});
router.post('/precos', async (req, res, next) => {
  try {
    const clienteId = pInt(req.body.cliente_id), produtoId = pInt(req.body.produto_id), preco = parsePrecoToCentavos(req.body.preco);
    if (!clienteId || !produtoId) throw new Error('Escolha cliente e produto.');
    if (preco === null) throw new Error('Informe o preço negociado.');
    const prod = await db.query('SELECT nome FROM produtos WHERE id = $1', [produtoId]);
    if (prod.rowCount === 0) throw new Error('Produto inválido.');
    await db.query('INSERT INTO itens (cliente_id, produto_id, nome, preco_centavos) VALUES ($1,$2,$3,$4)', [clienteId, produtoId, prod.rows[0].nome, preco]);
    res.redirect('/admin/precos?cliente=' + clienteId);
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
    await db.query('UPDATE itens SET promo_tipo = $2, promo_valor = $3, promo_inicio = $4, promo_fim = $5 WHERE id = $1', [id, tipo, valor, ini, fim]);
    res.redirect('/admin/precos?cliente=' + cid + '&ok=' + encodeURIComponent('Promoção aplicada.'));
  } catch (e) { res.redirect('/admin/precos?cliente=' + cid + '&erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/precos/:id/promo/remover', async (req, res, next) => {
  try {
    const it = await db.query('UPDATE itens SET promo_tipo = NULL, promo_valor = NULL, promo_inicio = NULL, promo_fim = NULL WHERE id = $1 RETURNING cliente_id', [pInt(req.params.id)]);
    res.redirect('/admin/precos?cliente=' + (it.rowCount ? it.rows[0].cliente_id : '') + '&ok=' + encodeURIComponent('Promoção removida.'));
  } catch (e) { next(e); }
});
router.post('/precos/:id/remove', async (req, res, next) => {
  try {
    const it = await db.query('UPDATE itens SET ativo = FALSE WHERE id = $1 RETURNING cliente_id', [req.params.id]);
    res.redirect('/admin/precos?cliente=' + (it.rowCount ? it.rows[0].cliente_id : ''));
  } catch (e) { next(e); }
});

module.exports = router;
