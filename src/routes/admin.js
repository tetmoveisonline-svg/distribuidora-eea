'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { exigeAdmin } = require('../auth');
const { enviarEtiquetas } = require('../etiquetas');
const financeiro = require('../financeiro');
const {
  formatBRL, formatDateTime, formatPercent, comissaoCentavos, andamentoDisplay,
  horasRestantes, etiquetasExpiradas, parsePrecoToCentavos, parsePercentToBps,
} = require('../util');

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
    res.render('admin/pedidos', { pedidos, funcRef: fr, formatBRL, formatDateTime });
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
    const fr = await funcRef();
    const etqs = await db.query(
      `SELECT e.indice, e.codigo, e.codigo_externo, e.status, e.despachado_em, l.item_nome
       FROM etiquetas e LEFT JOIN linhas l ON l.id = e.linha_id
       WHERE e.pedido_id = $1 ORDER BY e.indice`, [pedido.id]
    );
    const etqDespachadas = etqs.rows.filter((e) => e.status === 'despachado').length;
    res.render('admin/pedido', {
      pedido, linhas: linhas.rows, reps: reps.rows, funcRef: fr,
      taxaFuncCentavos: fr ? fr.taxa_etiqueta_centavos * pedido.total_etiquetas : null,
      passos: andamentoDisplay(pedido),
      etiquetas: etqs.rows, etqDespachadas, etqTotal: etqs.rowCount,
      expirado: etiquetasExpiradas(pedido.etiquetas_expira_em), horas: horasRestantes(pedido.etiquetas_expira_em),
      formatBRL, formatDateTime, formatPercent,
    });
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
router.post('/clientes/:id/prazo', async (req, res, next) => {
  try {
    const dias = pInt(req.body.prazo_dias);
    if (dias === null || dias < 0 || dias > 365) return res.redirect('/admin/clientes?erro=' + encodeURIComponent('Prazo inválido (0 a 365 dias).'));
    await db.query('UPDATE clientes SET prazo_dias = $2 WHERE id = $1', [pInt(req.params.id), dias]);
    res.redirect('/admin/clientes');
  } catch (e) { next(e); }
});
router.get('/clientes', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.nome, c.ativo, c.prazo_dias, u.login,
              (SELECT count(*) FROM itens i WHERE i.cliente_id = c.id AND i.ativo) AS produtos
       FROM clientes c LEFT JOIN usuarios u ON u.cliente_id = c.id AND u.papel = 'cliente' ORDER BY c.nome`
    );
    res.render('admin/clientes', { clientes: r.rows, ativo: 'clientes', erro: req.query.erro || null });
  } catch (e) { next(e); }
});
router.post('/clientes', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const nome = (req.body.nome || '').trim(), email = (req.body.email || '').trim(), login = (req.body.login || '').trim(), senha = req.body.senha || '';
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    let prazo = pInt(req.body.prazo_dias); if (prazo === null || prazo < 0 || prazo > 365) prazo = 7;
    await client.query('BEGIN');
    const c = await client.query('INSERT INTO clientes (nome, email, prazo_dias) VALUES ($1,$2,$3) RETURNING id', [nome, email || null, prazo]);
    await client.query('INSERT INTO usuarios (nome, login, senha_hash, papel, cliente_id) VALUES ($1,$2,$3,$4,$5)', [nome, login, await bcrypt.hash(senha, 10), 'cliente', c.rows[0].id]);
    await client.query('COMMIT');
    res.redirect('/admin/clientes');
  } catch (e) { await client.query('ROLLBACK'); res.redirect('/admin/clientes?erro=' + encodeURIComponent(msgErro(e))); } finally { client.release(); }
});
router.post('/clientes/:id/toggle', async (req, res, next) => {
  try {
    await db.query('UPDATE clientes SET ativo = NOT ativo WHERE id = $1', [req.params.id]);
    await db.query("UPDATE usuarios SET ativo = (SELECT ativo FROM clientes WHERE id = $1) WHERE cliente_id = $1 AND papel = 'cliente'", [req.params.id]);
    res.redirect('/admin/clientes');
  } catch (e) { next(e); }
});

// ===================== REPRESENTANTES =====================
router.get('/representantes', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT u.id, u.nome, u.login, u.ativo, u.comissao_bps,
              (SELECT count(*) FROM pedidos p WHERE p.representante_id = u.id) AS pedidos
       FROM usuarios u WHERE u.papel = 'representante' ORDER BY u.nome`
    );
    res.render('admin/representantes', { reps: r.rows, ativo: 'reps', erro: req.query.erro || null, formatPercent });
  } catch (e) { next(e); }
});
router.post('/representantes', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim(), login = (req.body.login || '').trim(), senha = req.body.senha || '';
    const bps = parsePercentToBps(req.body.comissao);
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    if (bps === null) throw new Error('Informe a comissão padrão (%).');
    await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel, comissao_bps) VALUES ($1,$2,$3,$4,$5)', [nome, login, await bcrypt.hash(senha, 10), 'representante', bps]);
    res.redirect('/admin/representantes');
  } catch (e) { res.redirect('/admin/representantes?erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/representantes/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE usuarios SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/representantes'); } catch (e) { next(e); }
});

// ===================== FUNCIONARIOS =====================
router.get('/funcionarios', async (req, res, next) => {
  try {
    const r = await db.query("SELECT id, nome, login, ativo, taxa_etiqueta_centavos FROM usuarios WHERE papel = 'funcionario' ORDER BY nome");
    res.render('admin/funcionarios', { funcs: r.rows, ativo: 'funcs', erro: req.query.erro || null, formatBRL });
  } catch (e) { next(e); }
});
router.post('/funcionarios', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim(), login = (req.body.login || '').trim(), senha = req.body.senha || '';
    const taxa = parsePrecoToCentavos(req.body.taxa);
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    if (taxa === null) throw new Error('Informe a taxa por etiqueta (R$).');
    await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel, taxa_etiqueta_centavos) VALUES ($1,$2,$3,$4,$5)', [nome, login, await bcrypt.hash(senha, 10), 'funcionario', taxa]);
    res.redirect('/admin/funcionarios');
  } catch (e) { res.redirect('/admin/funcionarios?erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/funcionarios/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE usuarios SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/funcionarios'); } catch (e) { next(e); }
});

// ===================== PRODUTOS =====================
router.get('/produtos', async (req, res, next) => {
  try {
    const r = await db.query('SELECT id, nome, descricao, ativo FROM produtos ORDER BY nome');
    res.render('admin/produtos', { produtos: r.rows, ativo: 'produtos', erro: req.query.erro || null });
  } catch (e) { next(e); }
});
router.post('/produtos', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim();
    if (!nome) throw new Error('Informe o nome do produto.');
    await db.query('INSERT INTO produtos (nome, descricao) VALUES ($1,$2)', [nome, (req.body.descricao || '').trim() || null]);
    res.redirect('/admin/produtos');
  } catch (e) { res.redirect('/admin/produtos?erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/produtos/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE produtos SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/produtos'); } catch (e) { next(e); }
});

// ===================== PRECOS POR CLIENTE =====================
router.get('/precos', async (req, res, next) => {
  try {
    const clientes = await db.query('SELECT id, nome FROM clientes WHERE ativo = TRUE ORDER BY nome');
    const produtos = await db.query('SELECT id, nome FROM produtos WHERE ativo = TRUE ORDER BY nome');
    let clienteId = pInt(req.query.cliente);
    if (!clienteId && clientes.rowCount > 0) clienteId = clientes.rows[0].id;
    let itens = { rows: [] }, clienteNome = '';
    if (clienteId) {
      itens = await db.query('SELECT id, nome, preco_centavos FROM itens WHERE cliente_id = $1 AND ativo = TRUE ORDER BY nome', [clienteId]);
      const cn = await db.query('SELECT nome FROM clientes WHERE id = $1', [clienteId]);
      clienteNome = cn.rowCount ? cn.rows[0].nome : '';
    }
    res.render('admin/precos', { clientes: clientes.rows, produtos: produtos.rows, itens: itens.rows, clienteId, clienteNome, ativo: 'precos', erro: req.query.erro || null, formatBRL });
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
router.post('/precos/:id/remove', async (req, res, next) => {
  try {
    const it = await db.query('UPDATE itens SET ativo = FALSE WHERE id = $1 RETURNING cliente_id', [req.params.id]);
    res.redirect('/admin/precos?cliente=' + (it.rowCount ? it.rows[0].cliente_id : ''));
  } catch (e) { next(e); }
});

module.exports = router;
