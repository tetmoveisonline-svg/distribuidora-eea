'use strict';

const express = require('express');
const db = require('../db');
const { exigeRepresentante } = require('../auth');
const { formatBRL, formatDateTime, formatPercent } = require('../util');

const router = express.Router();
router.use(exigeRepresentante);

// Taxa de referencia do funcionario (se houver exatamente um ativo com taxa).
async function taxaFuncRef() {
  const r = await db.query(
    "SELECT taxa_etiqueta_centavos FROM usuarios WHERE papel = 'funcionario' AND ativo = TRUE AND taxa_etiqueta_centavos IS NOT NULL ORDER BY id"
  );
  return r.rowCount === 1 ? r.rows[0].taxa_etiqueta_centavos : null;
}

router.get('/pedidos', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas,
              p.comissao_bps, p.comissao_centavos, p.aceite_em, c.nome AS cliente_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       WHERE p.representante_id = $1
       ORDER BY p.id DESC`, [req.session.user.id]
    );
    const taxaRef = await taxaFuncRef();
    let base = 0, comissao = 0;
    const pedidos = r.rows.map((p) => {
      base += p.total_centavos;
      comissao += (p.comissao_centavos || 0);
      return { ...p, taxa_func_centavos: taxaRef !== null ? taxaRef * p.total_etiquetas : null };
    });
    res.render('rep/pedidos', {
      pedidos, ativo: 'rep',
      totais: { pedidos: pedidos.length, base, comissao },
      temTaxaFunc: taxaRef !== null,
      formatBRL, formatDateTime, formatPercent,
    });
  } catch (e) { next(e); }
});

module.exports = router;
