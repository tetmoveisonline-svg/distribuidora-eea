'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { exigeAdmin } = require('../auth');
const { juntarEtiquetas } = require('../etiquetas');
const { gerarComprovanteDoPedido } = require('../comprovante-pedido');
const {
  formatBRL, formatDateTime, formatPercent, formatDesconto, comissaoCentavos, andamentoDisplay,
  horasRestantes, etiquetasExpiradas, parsePrecoToCentavos, parsePercentToBps,
  descontoItem, descontoTotal,
} = require('../util');

const router = express.Router();
router.use(exigeAdmin);

function pInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function asArray(v) { return v === undefined ? [] : (Array.isArray(v) ? v : [v]); }
function msgErro(e) {
  if (e && e.code === '23505') return 'Login já em uso. Escolha outro.';
  return (e && e.message) ? e.message : 'Falha ao salvar.';
}
function naoEncontrado(res, req) {
  return res.status(404).render('erro', { titulo: 'Não encontrado', mensagem: 'Registro inexistente.', user: req.session.user });
}
function enviarPdf(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buffer);
}
async function funcRef() {
  const r = await db.query(
    "SELECT id, nome, taxa_etiqueta_centavos FROM usuarios WHERE papel = 'funcionario' AND ativo = TRUE AND taxa_etiqueta_centavos IS NOT NULL ORDER BY id"
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}
// Le desconto do corpo (tipo/valor). Valor em bps (pct) ou centavos (val). Retorna {tipo,valor} ou {tipo:null,valor:null}.
function lerDesconto(tipoRaw, valorRaw) {
  const tipo = (tipoRaw === 'pct' || tipoRaw === 'val') ? tipoRaw : null;
  if (!tipo) return { tipo: null, valor: null };
  const valor = tipo === 'pct' ? parsePercentToBps(valorRaw) : parsePrecoToCentavos(valorRaw);
  if (!valor) return { tipo: null, valor: null };
  return { tipo, valor };
}

// ===================== PEDIDOS =====================
router.get('/pedidos', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas,
              p.aceite_em, p.etiquetas_expira_em, p.despachado_em,
              p.comissao_centavos, c.nome AS cliente_nome, u.nome AS rep_nome
       FROM pedidos p
       JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios u ON u.id = p.representante_id
       ORDER BY p.id DESC`
    );
    const fr = await funcRef();
    const pedidos = r.rows.map((p) => ({
      ...p,
      expirado: etiquetasExpiradas(p.etiquetas_expira_em),
      horas: horasRestantes(p.etiquetas_expira_em),
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
    res.render('admin/pedido', {
      pedido, linhas: linhas.rows, reps: reps.rows, funcRef: fr,
      taxaFuncCentavos: fr ? fr.taxa_etiqueta_centavos * pedido.total_etiquetas : null,
      passos: andamentoDisplay(pedido),
      expirado: etiquetasExpiradas(pedido.etiquetas_expira_em),
      horas: horasRestantes(pedido.etiquetas_expira_em),
      formatBRL, formatDateTime, formatPercent, formatDesconto,
    });
  } catch (e) { next(e); }
});

// Editar descontos do pedido (por item + no total) e regerar comprovante.
router.post('/pedido/:id/desconto', async (req, res, next) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const pr = await client.query('SELECT id, representante_id, comissao_bps FROM pedidos WHERE id = $1', [req.params.id]);
    if (pr.rowCount === 0) { await client.query('ROLLBACK'); return naoEncontrado(res, req); }
    const linhas = await client.query('SELECT id, quantidade, bruto_centavos FROM linhas WHERE pedido_id = $1 ORDER BY id', [req.params.id]);

    let subtotal = 0, descItens = 0;
    for (const l of linhas.rows) {
      const d = lerDesconto(req.body['dtipo_' + l.id], req.body['dvalor_' + l.id]);
      const desc = descontoItem(l.bruto_centavos, l.quantidade, d.tipo, d.valor);
      subtotal += l.bruto_centavos;
      descItens += desc;
      await client.query(
        'UPDATE linhas SET desconto_tipo = $1, desconto_valor = $2, desconto_centavos = $3, total_centavos = $4 WHERE id = $5',
        [d.tipo, d.valor, desc, l.bruto_centavos - desc, l.id]
      );
    }
    const subAfter = subtotal - descItens;
    const dt = lerDesconto(req.body.total_tipo, req.body.total_valor);
    const descTot = descontoTotal(subAfter, dt.tipo, dt.valor);
    const totalFinal = subAfter - descTot;

    await client.query(
      `UPDATE pedidos SET subtotal_centavos = $1, desconto_itens_centavos = $2,
        desconto_total_tipo = $3, desconto_total_valor = $4, desconto_total_centavos = $5, total_centavos = $6
       WHERE id = $7`,
      [subtotal, descItens, dt.tipo, dt.valor, descTot, totalFinal, req.params.id]
    );

    // Recalcula comissao se houver representante.
    if (pr.rows[0].representante_id && pr.rows[0].comissao_bps) {
      await client.query('UPDATE pedidos SET comissao_centavos = $1 WHERE id = $2',
        [comissaoCentavos(totalFinal, pr.rows[0].comissao_bps), req.params.id]);
    }

    const pdf = await gerarComprovanteDoPedido(client, req.params.id);
    await client.query('UPDATE pedidos SET comprovante = $1 WHERE id = $2', [pdf, req.params.id]);

    await client.query('COMMIT');
    res.redirect('/admin/pedido/' + req.params.id);
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
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
    await db.query('UPDATE pedidos SET representante_id = $1, comissao_bps = $2, comissao_centavos = $3 WHERE id = $4',
      [repId, bps, comissaoCentavos(total, bps), req.params.id]);
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

router.get('/pedido/:id/etiquetas', async (req, res, next) => {
  try {
    const p = await db.query('SELECT id, numero, etiquetas_expira_em FROM pedidos WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0) return naoEncontrado(res, req);
    if (etiquetasExpiradas(p.rows[0].etiquetas_expira_em)) {
      return res.status(410).render('erro', { titulo: 'Etiquetas expiradas', mensagem: 'As etiquetas deste pedido expiraram (72h). O cliente precisa reenviar.', user: req.session.user });
    }
    const arqs = await db.query('SELECT conteudo FROM arquivos WHERE pedido_id = $1 ORDER BY id', [p.rows[0].id]);
    if (arqs.rowCount === 0) return naoEncontrado(res, req);
    enviarPdf(res, 'etiquetas-' + p.rows[0].numero + '.pdf', await juntarEtiquetas(arqs.rows.map((r) => r.conteudo)));
  } catch (e) { next(e); }
});

router.get('/pedido/:id/comprovante', async (req, res, next) => {
  try {
    const p = await db.query('SELECT numero, comprovante FROM pedidos WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0 || !p.rows[0].comprovante) return naoEncontrado(res, req);
    enviarPdf(res, 'comprovante-' + p.rows[0].numero + '.pdf', p.rows[0].comprovante);
  } catch (e) { next(e); }
});

// ===================== CLIENTES =====================
router.get('/clientes', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.nome, c.ativo, c.desconto_tipo, c.desconto_escopo, c.desconto_valor, u.login,
              (SELECT count(*) FROM itens i WHERE i.cliente_id = c.id AND i.ativo) AS produtos
       FROM clientes c LEFT JOIN usuarios u ON u.cliente_id = c.id AND u.papel = 'cliente'
       ORDER BY c.nome`
    );
    res.render('admin/clientes', { clientes: r.rows, ativo: 'clientes', erro: req.query.erro || null, formatDesconto });
  } catch (e) { next(e); }
});

router.post('/clientes', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const nome = (req.body.nome || '').trim();
    const email = (req.body.email || '').trim();
    const login = (req.body.login || '').trim();
    const senha = req.body.senha || '';
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    const d = lerDesconto(req.body.desconto_tipo, req.body.desconto_valor);
    const escopo = (req.body.desconto_escopo === 'total') ? 'total' : 'item';

    await client.query('BEGIN');
    const c = await client.query(
      'INSERT INTO clientes (nome, email, desconto_tipo, desconto_escopo, desconto_valor) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [nome, email || null, d.tipo, d.tipo ? escopo : null, d.valor]
    );
    await client.query('INSERT INTO usuarios (nome, login, senha_hash, papel, cliente_id) VALUES ($1,$2,$3,$4,$5)',
      [nome, login, await bcrypt.hash(senha, 10), 'cliente', c.rows[0].id]);
    await client.query('COMMIT');
    res.redirect('/admin/clientes');
  } catch (e) {
    await client.query('ROLLBACK');
    res.redirect('/admin/clientes?erro=' + encodeURIComponent(msgErro(e)));
  } finally { client.release(); }
});

router.post('/clientes/:id/desconto', async (req, res, next) => {
  try {
    const d = lerDesconto(req.body.desconto_tipo, req.body.desconto_valor);
    const escopo = (req.body.desconto_escopo === 'total') ? 'total' : 'item';
    await db.query('UPDATE clientes SET desconto_tipo = $1, desconto_escopo = $2, desconto_valor = $3 WHERE id = $4',
      [d.tipo, d.tipo ? escopo : null, d.valor, req.params.id]);
    res.redirect('/admin/clientes');
  } catch (e) { next(e); }
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
    await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel, comissao_bps) VALUES ($1,$2,$3,$4,$5)',
      [nome, login, await bcrypt.hash(senha, 10), 'representante', bps]);
    res.redirect('/admin/representantes');
  } catch (e) { res.redirect('/admin/representantes?erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/representantes/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE usuarios SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/representantes'); }
  catch (e) { next(e); }
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
    await db.query('INSERT INTO usuarios (nome, login, senha_hash, papel, taxa_etiqueta_centavos) VALUES ($1,$2,$3,$4,$5)',
      [nome, login, await bcrypt.hash(senha, 10), 'funcionario', taxa]);
    res.redirect('/admin/funcionarios');
  } catch (e) { res.redirect('/admin/funcionarios?erro=' + encodeURIComponent(msgErro(e))); }
});
router.post('/funcionarios/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE usuarios SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/funcionarios'); }
  catch (e) { next(e); }
});

// ===================== PRODUTOS (preco + cores/estoque) =====================
router.get('/produtos', async (req, res, next) => {
  try {
    const prod = await db.query('SELECT id, nome, descricao, preco_padrao_centavos, ativo FROM produtos ORDER BY nome');
    const cores = await db.query('SELECT id, produto_id, nome, estoque FROM produto_cores WHERE ativo = TRUE ORDER BY nome');
    const coresByProd = {};
    cores.rows.forEach((c) => { (coresByProd[c.produto_id] = coresByProd[c.produto_id] || []).push(c); });
    const produtos = prod.rows.map((p) => ({ ...p, cores: coresByProd[p.id] || [] }));
    res.render('admin/produtos', { produtos, ativo: 'produtos', erro: req.query.erro || null, formatBRL });
  } catch (e) { next(e); }
});

router.post('/produtos', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const nome = (req.body.nome || '').trim();
    const preco = parsePrecoToCentavos(req.body.preco);
    if (!nome) throw new Error('Informe o nome do produto.');
    if (preco === null) throw new Error('Informe o preço padrão.');
    const nomes = asArray(req.body.cor_nome), estoques = asArray(req.body.cor_estoque);

    await client.query('BEGIN');
    const pr = await client.query('INSERT INTO produtos (nome, descricao, preco_padrao_centavos) VALUES ($1,$2,$3) RETURNING id',
      [nome, (req.body.descricao || '').trim() || null, preco]);
    const prodId = pr.rows[0].id;
    for (let i = 0; i < nomes.length; i++) {
      const cn = (nomes[i] || '').trim();
      if (!cn) continue;
      const est = pInt(estoques[i]) || 0;
      await client.query('INSERT INTO produto_cores (produto_id, nome, estoque) VALUES ($1,$2,$3)', [prodId, cn, est]);
    }
    await client.query('COMMIT');
    res.redirect('/admin/produtos');
  } catch (e) {
    await client.query('ROLLBACK');
    res.redirect('/admin/produtos?erro=' + encodeURIComponent(msgErro(e)));
  } finally { client.release(); }
});

router.get('/produto/:id', async (req, res, next) => {
  try {
    const p = await db.query('SELECT id, nome, descricao, preco_padrao_centavos, ativo FROM produtos WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0) return naoEncontrado(res, req);
    const cores = await db.query('SELECT id, nome, estoque, ativo FROM produto_cores WHERE produto_id = $1 AND ativo = TRUE ORDER BY nome', [req.params.id]);
    res.render('admin/produto', { produto: p.rows[0], cores: cores.rows, ativo: 'produtos', formatBRL });
  } catch (e) { next(e); }
});

router.post('/produto/:id', async (req, res, next) => {
  try {
    const nome = (req.body.nome || '').trim();
    const preco = parsePrecoToCentavos(req.body.preco);
    if (!nome || preco === null) return res.redirect('/admin/produto/' + req.params.id);
    await db.query('UPDATE produtos SET nome = $1, descricao = $2, preco_padrao_centavos = $3 WHERE id = $4',
      [nome, (req.body.descricao || '').trim() || null, preco, req.params.id]);
    res.redirect('/admin/produto/' + req.params.id);
  } catch (e) { next(e); }
});

router.post('/produto/:id/cor', async (req, res, next) => {
  try {
    const cn = (req.body.cor_nome || '').trim();
    if (cn) await db.query('INSERT INTO produto_cores (produto_id, nome, estoque) VALUES ($1,$2,$3)',
      [req.params.id, cn, pInt(req.body.cor_estoque) || 0]);
    res.redirect('/admin/produto/' + req.params.id);
  } catch (e) { next(e); }
});

router.post('/cor/:id/estoque', async (req, res, next) => {
  try {
    const est = pInt(req.body.estoque);
    const c = await db.query('UPDATE produto_cores SET estoque = $1 WHERE id = $2 RETURNING produto_id', [est === null ? 0 : est, req.params.id]);
    res.redirect('/admin/produto/' + (c.rowCount ? c.rows[0].produto_id : ''));
  } catch (e) { next(e); }
});

router.post('/cor/:id/remove', async (req, res, next) => {
  try {
    const c = await db.query('UPDATE produto_cores SET ativo = FALSE WHERE id = $1 RETURNING produto_id', [req.params.id]);
    res.redirect('/admin/produto/' + (c.rowCount ? c.rows[0].produto_id : ''));
  } catch (e) { next(e); }
});

router.post('/produtos/:id/toggle', async (req, res, next) => {
  try { await db.query('UPDATE produtos SET ativo = NOT ativo WHERE id = $1', [req.params.id]); res.redirect('/admin/produtos'); }
  catch (e) { next(e); }
});

// ===================== PRODUTOS POR CLIENTE (liberados) =====================
router.get('/liberados', async (req, res, next) => {
  try {
    const clientes = await db.query('SELECT id, nome FROM clientes WHERE ativo = TRUE ORDER BY nome');
    let clienteId = pInt(req.query.cliente);
    if (!clienteId && clientes.rowCount > 0) clienteId = clientes.rows[0].id;

    let liberados = { rows: [] }, disponiveis = { rows: [] }, clienteNome = '';
    if (clienteId) {
      liberados = await db.query(
        `SELECT i.id, p.nome, p.preco_padrao_centavos
         FROM itens i JOIN produtos p ON p.id = i.produto_id
         WHERE i.cliente_id = $1 AND i.ativo = TRUE ORDER BY p.nome`, [clienteId]
      );
      disponiveis = await db.query(
        `SELECT id, nome, preco_padrao_centavos FROM produtos
         WHERE ativo = TRUE AND id NOT IN (SELECT produto_id FROM itens WHERE cliente_id = $1 AND ativo = TRUE AND produto_id IS NOT NULL)
         ORDER BY nome`, [clienteId]
      );
      const cn = await db.query('SELECT nome FROM clientes WHERE id = $1', [clienteId]);
      clienteNome = cn.rowCount ? cn.rows[0].nome : '';
    }
    res.render('admin/liberados', {
      clientes: clientes.rows, liberados: liberados.rows, disponiveis: disponiveis.rows,
      clienteId, clienteNome, ativo: 'liberados', erro: req.query.erro || null, formatBRL,
    });
  } catch (e) { next(e); }
});

router.post('/liberados', async (req, res, next) => {
  try {
    const clienteId = pInt(req.body.cliente_id);
    const produtoId = pInt(req.body.produto_id);
    if (!clienteId || !produtoId) throw new Error('Escolha cliente e produto.');
    const prod = await db.query('SELECT nome, preco_padrao_centavos FROM produtos WHERE id = $1', [produtoId]);
    if (prod.rowCount === 0) throw new Error('Produto inválido.');
    await db.query('INSERT INTO itens (cliente_id, produto_id, nome, preco_centavos) VALUES ($1,$2,$3,$4)',
      [clienteId, produtoId, prod.rows[0].nome, prod.rows[0].preco_padrao_centavos]);
    res.redirect('/admin/liberados?cliente=' + clienteId);
  } catch (e) {
    const cid = pInt(req.body.cliente_id) || '';
    res.redirect('/admin/liberados?cliente=' + cid + '&erro=' + encodeURIComponent(msgErro(e)));
  }
});

router.post('/liberados/:id/remove', async (req, res, next) => {
  try {
    const it = await db.query('UPDATE itens SET ativo = FALSE WHERE id = $1 RETURNING cliente_id', [req.params.id]);
    res.redirect('/admin/liberados?cliente=' + (it.rowCount ? it.rows[0].cliente_id : ''));
  } catch (e) { next(e); }
});

module.exports = router;
