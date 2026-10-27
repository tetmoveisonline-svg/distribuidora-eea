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
    const uid = req.session.user.id;
    // O representante ve os pedidos onde ele e o representante direto (ou preposto) E tambem
    // aqueles em que ele e o responsavel-pai de um preposto (recebe a fatia dele nesses).
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas,
              p.representante_id, p.responsavel_id, p.comissao_bps, p.comissao_centavos,
              p.comissao_resp_bps, p.comissao_resp_centavos, p.aceite_em,
              c.nome AS cliente_nome, prep.nome AS preposto_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios prep ON prep.id = p.representante_id
       WHERE p.representante_id = $1 OR p.responsavel_id = $1
       ORDER BY p.id DESC`, [uid]
    );
    const taxaRef = await taxaFuncRef();
    let base = 0, comissao = 0;
    const pedidos = r.rows.map((p) => {
      const ehResp = Number(p.representante_id) !== Number(uid) && Number(p.responsavel_id) === Number(uid);
      const minhaBps = ehResp ? (p.comissao_resp_bps || 0) : (p.comissao_bps || 0);
      const minhaComissao = ehResp ? (p.comissao_resp_centavos || 0) : (p.comissao_centavos || 0);
      base += p.total_centavos;
      comissao += minhaComissao;
      return {
        ...p, minha_bps: minhaBps, minha_comissao: minhaComissao,
        origem: ehResp ? ('Via preposto ' + (p.preposto_nome || '')) : 'Direto', eh_resp: ehResp,
        taxa_func_centavos: taxaRef !== null ? taxaRef * p.total_etiquetas : null,
      };
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
