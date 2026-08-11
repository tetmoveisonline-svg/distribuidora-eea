'use strict';

const express = require('express');
const db = require('../db');
const { exigeAdmin } = require('../auth');
const { juntarEtiquetas } = require('../etiquetas');
const { formatBRL, formatDateTime, horasRestantes, etiquetasExpiradas } = require('../util');

const router = express.Router();

// ---------- Pedidos recebidos ----------
router.get('/pedidos', exigeAdmin, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas,
              p.aceite_em, p.etiquetas_expira_em, p.despachado_em, c.nome AS cliente_nome
       FROM pedidos p
       JOIN clientes c ON c.id = p.cliente_id
       ORDER BY p.id DESC`
    );
    const pedidos = r.rows.map((p) => ({
      ...p,
      expirado: etiquetasExpiradas(p.etiquetas_expira_em),
      horas: horasRestantes(p.etiquetas_expira_em),
    }));
    res.render('admin/pedidos', { pedidos, formatBRL, formatDateTime });
  } catch (e) { next(e); }
});

// ---------- Marcar despachado ----------
router.post('/pedidos/:id/despachar', exigeAdmin, async (req, res, next) => {
  try {
    await db.query(
      "UPDATE pedidos SET status = 'despachado', despachado_em = now() WHERE id = $1 AND status <> 'despachado'",
      [req.params.id]
    );
    res.redirect('/admin/pedidos');
  } catch (e) { next(e); }
});

// ---------- Download: etiquetas (72h) ----------
router.get('/pedido/:id/etiquetas', exigeAdmin, async (req, res, next) => {
  try {
    const p = await db.query('SELECT id, numero, etiquetas_expira_em FROM pedidos WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0) return notFound(res, req);
    if (etiquetasExpiradas(p.rows[0].etiquetas_expira_em)) {
      return res.status(410).render('erro', { titulo: 'Etiquetas expiradas', mensagem: 'As etiquetas deste pedido expiraram (72h). O cliente precisa reenviar.', user: req.session.user });
    }
    const arqs = await db.query('SELECT conteudo FROM arquivos WHERE pedido_id = $1 ORDER BY id', [p.rows[0].id]);
    if (arqs.rowCount === 0) return notFound(res, req);
    const merged = await juntarEtiquetas(arqs.rows.map((r) => r.conteudo));
    enviarPdf(res, 'etiquetas-' + p.rows[0].numero + '.pdf', merged);
  } catch (e) { next(e); }
});

// ---------- Download: comprovante (permanente) ----------
router.get('/pedido/:id/comprovante', exigeAdmin, async (req, res, next) => {
  try {
    const p = await db.query('SELECT numero, comprovante FROM pedidos WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0 || !p.rows[0].comprovante) return notFound(res, req);
    enviarPdf(res, 'comprovante-' + p.rows[0].numero + '.pdf', p.rows[0].comprovante);
  } catch (e) { next(e); }
});

function notFound(res, req) {
  return res.status(404).render('erro', { titulo: 'Nao encontrado', mensagem: 'Registro inexistente.', user: req.session.user });
}

function enviarPdf(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buffer);
}

module.exports = router;
