'use strict';

const express = require('express');
const db = require('../db');
const { exigeFuncionario } = require('../auth');
const { formatBRL, formatDateTime } = require('../util');

const router = express.Router();
router.use(exigeFuncionario);

router.get('/pedidos', async (req, res, next) => {
  try {
    // Taxa por etiqueta deste funcionario.
    const me = await db.query('SELECT taxa_etiqueta_centavos FROM usuarios WHERE id = $1', [req.session.user.id]);
    const taxa = (me.rowCount && me.rows[0].taxa_etiqueta_centavos != null) ? me.rows[0].taxa_etiqueta_centavos : 0;

    // Todos os pedidos (funcionario ve tudo). NAO traz comissao do representante.
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_etiquetas, p.aceite_em,
              c.nome AS cliente_nome,
              (SELECT string_agg(DISTINCT l.item_nome, ', ') FROM linhas l WHERE l.pedido_id = p.id) AS produtos
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       ORDER BY p.id DESC`
    );
    let etiquetas = 0, totalTaxa = 0;
    const pedidos = r.rows.map((p) => {
      etiquetas += p.total_etiquetas;
      const t = taxa * p.total_etiquetas;
      totalTaxa += t;
      return { ...p, taxa_centavos: t };
    });
    res.render('func/pedidos', {
      pedidos, ativo: 'func', taxaEtiqueta: taxa,
      totais: { pedidos: pedidos.length, etiquetas, taxa: totalTaxa },
      formatBRL, formatDateTime,
    });
  } catch (e) { next(e); }
});

module.exports = router;
