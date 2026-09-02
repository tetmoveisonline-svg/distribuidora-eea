'use strict';

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { exigeCliente } = require('../auth');
const { contarPaginas, enviarEtiquetas } = require('../etiquetas');
const { gerarComprovanteDoPedido } = require('../comprovante-pedido');
const { formatBRL, formatDateTime, horasRestantes, etiquetasExpiradas, andamentoDisplay, descontoItem, descontoTotal } = require('../util');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) return cb(null, true);
    cb(null, false);
  },
});

function pad2(n) { return String(n).padStart(2, '0'); }
function enviarPdf(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buffer);
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }

// ---------- Novo envio ----------
router.get('/novo', exigeCliente, async (req, res, next) => {
  try {
    const cid = req.session.user.clienteId;
    const itensR = await db.query(
      `SELECT i.id, i.produto_id, p.nome, p.preco_padrao_centavos AS preco_centavos
       FROM itens i JOIN produtos p ON p.id = i.produto_id
       WHERE i.cliente_id = $1 AND i.ativo = TRUE AND p.ativo = TRUE ORDER BY p.nome`, [cid]
    );
    const prodIds = itensR.rows.map((r) => r.produto_id);
    const cores = {};
    if (prodIds.length) {
      const cr = await db.query('SELECT id, produto_id, nome, estoque FROM produto_cores WHERE produto_id = ANY($1) AND ativo = TRUE ORDER BY nome', [prodIds]);
      cr.rows.forEach((c) => { (cores[c.produto_id] = cores[c.produto_id] || []).push({ id: c.id, nome: c.nome, estoque: c.estoque }); });
    }
    const itens = itensR.rows.map((r) => ({
      id: r.id, produto_id: r.produto_id, nome: r.nome, preco_centavos: r.preco_centavos, cores: cores[r.produto_id] || [],
    }));
    res.render('cliente/novo', { itens, formatBRL });
  } catch (e) { next(e); }
});

// ---------- Upload + deteccao de paginas ----------
router.post('/api/upload', exigeCliente, upload.array('arquivos', 30), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ erro: 'Envie ao menos um PDF.' });
    const resultado = [];
    for (const f of req.files) {
      let paginas = 0;
      try { paginas = await contarPaginas(f.buffer); }
      catch (e) { return res.status(400).json({ erro: 'Nao consegui ler o PDF "' + f.originalname + '". Verifique o arquivo.' }); }
      if (paginas < 1) return res.status(400).json({ erro: 'O arquivo "' + f.originalname + '" nao tem paginas validas.' });
      const ins = await db.query('INSERT INTO arquivos (usuario_id, nome, paginas, conteudo) VALUES ($1,$2,$3,$4) RETURNING id',
        [req.session.user.id, f.originalname, paginas, f.buffer]);
      resultado.push({ id: ins.rows[0].id, nome: f.originalname, paginas });
    }
    res.json({ arquivos: resultado });
  } catch (e) { console.error('Erro no upload:', e); res.status(500).json({ erro: 'Falha ao processar o upload.' }); }
});

// ---------- Criar pedido (aceite) ----------
router.post('/api/pedidos', exigeCliente, async (req, res) => {
  const clienteId = req.session.user.clienteId;
  const usuarioId = req.session.user.id;
  const body = req.body || {};
  const linhasReq = Array.isArray(body.itens) ? body.itens : [];

  if (body.aceite !== true) return res.status(400).json({ erro: 'E preciso confirmar os envios e valores para aceitar.' });
  if (linhasReq.length === 0) return res.status(400).json({ erro: 'Nenhum arquivo/item para gerar o pedido.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const cli = await client.query('SELECT nome, email, desconto_tipo, desconto_escopo, desconto_valor FROM clientes WHERE id = $1', [clienteId]);
    const cliente = cli.rows[0] || {};
    const descItemAtivo = cliente.desconto_tipo && cliente.desconto_valor && cliente.desconto_escopo === 'item';
    const descTotalAtivo = cliente.desconto_tipo && cliente.desconto_valor && cliente.desconto_escopo === 'total';

    const linhas = [];
    let subtotal = 0, descontoItens = 0, totalEtiquetas = 0;
    for (const l of linhasReq) {
      const arquivoId = parseInt(l.arquivoId, 10);
      const itemId = parseInt(l.itemId, 10);
      const corId = parseInt(l.corId, 10);
      const quantidade = parseInt(l.quantidade, 10);
      if (!arquivoId || !itemId || !corId || !quantidade || quantidade < 1) throw httpErr(400, 'Dados invalidos em uma das linhas (produto, cor e quantidade).');

      const item = await client.query(
        `SELECT i.id, i.produto_id, p.nome AS produto_nome, p.preco_padrao_centavos
         FROM itens i JOIN produtos p ON p.id = i.produto_id
         WHERE i.id = $1 AND i.cliente_id = $2 AND i.ativo = TRUE AND p.ativo = TRUE`, [itemId, clienteId]
      );
      if (item.rowCount === 0) throw httpErr(400, 'Produto invalido ou nao liberado para este cliente.');
      const it = item.rows[0];

      const arq = await client.query('SELECT id, nome FROM arquivos WHERE id = $1 AND usuario_id = $2 AND pedido_id IS NULL', [arquivoId, usuarioId]);
      if (arq.rowCount === 0) throw httpErr(400, 'Arquivo invalido ou ja utilizado.');

      const cor = await client.query('SELECT id, nome, estoque FROM produto_cores WHERE id = $1 AND produto_id = $2 AND ativo = TRUE FOR UPDATE', [corId, it.produto_id]);
      if (cor.rowCount === 0) throw httpErr(400, 'Cor invalida para este produto.');
      if (cor.rows[0].estoque < quantidade) {
        throw httpErr(400, 'Estoque insuficiente de ' + it.produto_nome + ' (' + cor.rows[0].nome + '): disponivel ' + cor.rows[0].estoque + ', pedido ' + quantidade + '.');
      }

      const preco = it.preco_padrao_centavos;
      const bruto = preco * quantidade;
      let dTipo = null, dValor = null, dCentavos = 0;
      if (descItemAtivo) { dTipo = cliente.desconto_tipo; dValor = cliente.desconto_valor; dCentavos = descontoItem(bruto, quantidade, dTipo, dValor); }
      subtotal += bruto; descontoItens += dCentavos; totalEtiquetas += quantidade;
      linhas.push({
        arquivoId, arquivoNome: arq.rows[0].nome, itemId: it.id, itemNome: it.produto_nome,
        corId: cor.rows[0].id, corNome: cor.rows[0].nome, precoCentavos: preco, quantidade,
        brutoCentavos: bruto, descTipo: dTipo, descValor: dValor, descCentavos: dCentavos, totalCentavos: bruto - dCentavos,
      });
    }

    const subAposItens = subtotal - descontoItens;
    let dtTipo = null, dtValor = null, descontoTot = 0;
    if (descTotalAtivo) { dtTipo = cliente.desconto_tipo; dtValor = cliente.desconto_valor; descontoTot = descontoTotal(subAposItens, dtTipo, dtValor); }
    const totalFinal = subAposItens - descontoTot;

    const seq = await client.query("SELECT 'DS-' || nextval('pedido_numero_seq') AS numero");
    const numero = seq.rows[0].numero;
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

    const ped = await client.query(
      `INSERT INTO pedidos
        (numero, cliente_id, usuario_id, status, total_centavos, total_etiquetas, aceite_em, aceite_ip, etiquetas_expira_em,
         subtotal_centavos, desconto_itens_centavos, desconto_total_tipo, desconto_total_valor, desconto_total_centavos)
       VALUES ($1,$2,$3,'aguardando',$4,$5, now(), $6, now() + interval '72 hours', $7,$8,$9,$10,$11)
       RETURNING id`,
      [numero, clienteId, usuarioId, totalFinal, totalEtiquetas, ip, subtotal, descontoItens, dtTipo, dtValor, descontoTot]
    );
    const pedidoId = ped.rows[0].id;

    let indiceGlobal = 0;
    for (const l of linhas) {
      await client.query('UPDATE arquivos SET pedido_id = $1 WHERE id = $2', [pedidoId, l.arquivoId]);
      await client.query('UPDATE produto_cores SET estoque = estoque - $1 WHERE id = $2', [l.quantidade, l.corId]);
      const linhaIns = await client.query(
        `INSERT INTO linhas
          (pedido_id, arquivo_id, item_id, item_nome, arquivo_nome, produto_cor_id, cor_nome,
           preco_centavos, quantidade, bruto_centavos, desconto_tipo, desconto_valor, desconto_centavos, total_centavos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [pedidoId, l.arquivoId, l.itemId, l.itemNome, l.arquivoNome, l.corId, l.corNome,
         l.precoCentavos, l.quantidade, l.brutoCentavos, l.descTipo, l.descValor, l.descCentavos, l.totalCentavos]
      );
      const linhaId = linhaIns.rows[0].id;
      for (let i = 0; i < l.quantidade; i++) {
        indiceGlobal++;
        await client.query('INSERT INTO etiquetas (pedido_id, linha_id, codigo, indice) VALUES ($1,$2,$3,$4)',
          [pedidoId, linhaId, numero + '-' + pad2(indiceGlobal), indiceGlobal]);
      }
    }

    await client.query('UPDATE pedidos SET observacoes = $1 WHERE id = $2', [(body.observacoes || '').toString().slice(0, 500) || null, pedidoId]);
    const pdfBuffer = await gerarComprovanteDoPedido(client, pedidoId);
    await client.query('UPDATE pedidos SET comprovante = $1 WHERE id = $2', [pdfBuffer, pedidoId]);

    await client.query('COMMIT');
    res.json({ ok: true, pedidoId, numero });
  } catch (e) {
    await client.query('ROLLBACK');
    const status = e.status || 500;
    if (status === 500) console.error('Erro ao criar pedido:', e);
    res.status(status).json({ erro: e.publicMessage || 'Falha ao gerar o pedido.' });
  } finally { client.release(); }
});

// ---------- Meus envios ----------
router.get('/meus-envios', exigeCliente, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, numero, status, total_centavos, total_etiquetas, aceite_em, criado_em,
              etiquetas_expira_em, preparando_em, despachado_em
       FROM pedidos WHERE cliente_id = $1 ORDER BY id DESC`, [req.session.user.clienteId]
    );
    const pedidos = r.rows.map((p) => ({
      ...p, expirado: etiquetasExpiradas(p.etiquetas_expira_em), horas: horasRestantes(p.etiquetas_expira_em), passos: andamentoDisplay(p),
    }));
    res.render('cliente/meus-envios', { pedidos, formatBRL, formatDateTime });
  } catch (e) { next(e); }
});

// ---------- Download: etiquetas (72h) - arquivos separados nomeados pelo produto ----------
router.get('/pedido/:id/etiquetas', exigeCliente, async (req, res, next) => {
  try {
    const p = await db.query('SELECT id, numero, etiquetas_expira_em FROM pedidos WHERE id = $1 AND cliente_id = $2', [req.params.id, req.session.user.clienteId]);
    if (p.rowCount === 0) return res.status(404).render('erro', { titulo: 'Pedido nao encontrado', mensagem: 'Pedido inexistente.', user: req.session.user });
    if (etiquetasExpiradas(p.rows[0].etiquetas_expira_em)) {
      return res.status(410).render('erro', { titulo: 'Etiquetas expiradas', mensagem: 'As etiquetas deste pedido expiraram (validade de 72h). Reenvie para gerar novas.', user: req.session.user });
    }
    const arqs = await db.query(
      `SELECT a.nome AS arquivo_nome, a.conteudo, l.item_nome
       FROM arquivos a LEFT JOIN linhas l ON l.arquivo_id = a.id
       WHERE a.pedido_id = $1 ORDER BY a.id`, [p.rows[0].id]
    );
    if (arqs.rowCount === 0) return res.status(404).render('erro', { titulo: 'Sem etiquetas', mensagem: 'Nenhum arquivo de etiqueta neste pedido.', user: req.session.user });
    enviarEtiquetas(res, p.rows[0].numero, arqs.rows);
  } catch (e) { next(e); }
});

// ---------- Download: comprovante (permanente) ----------
router.get('/pedido/:id/comprovante', exigeCliente, async (req, res, next) => {
  try {
    const p = await db.query('SELECT numero, comprovante FROM pedidos WHERE id = $1 AND cliente_id = $2', [req.params.id, req.session.user.clienteId]);
    if (p.rowCount === 0 || !p.rows[0].comprovante) return res.status(404).render('erro', { titulo: 'Comprovante indisponivel', mensagem: 'Comprovante nao encontrado.', user: req.session.user });
    enviarPdf(res, 'comprovante-' + p.rows[0].numero + '.pdf', p.rows[0].comprovante);
  } catch (e) { next(e); }
});

module.exports = router;
