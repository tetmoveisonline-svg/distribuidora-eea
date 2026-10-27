'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { exigeRepresentante } = require('../auth');
const { formatBRL, formatDateTime, formatPercent } = require('../util');

const router = express.Router();
router.use(exigeRepresentante);

function pInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

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

// ===================== MEUS CLIENTES (cadastro pelo representante/preposto) =====================
// A comissao do cliente e aplicada automaticamente pela regra do proprio usuario:
//   preposto  -> total = seu comissao_total_bps (padrao), fatia do preposto = seu comissao_bps; pai recebe o resto.
//   representante direto -> total = seu comissao_bps, sem divisao.
async function meuPadrao(uid) {
  const r = await db.query('SELECT comissao_bps, comissao_total_bps, representante_pai_id FROM usuarios WHERE id = $1', [uid]);
  const u = r.rows[0] || {};
  const ehPreposto = !!u.representante_pai_id;
  const fatia = Number(u.comissao_bps || 0);
  const total = ehPreposto ? Number(u.comissao_total_bps != null ? u.comissao_total_bps : u.comissao_bps || 0) : fatia;
  return { ehPreposto, fatia, total, minhaBps: fatia };
}

router.get('/clientes', async (req, res, next) => {
  try {
    const uid = req.session.user.id;
    const pad = await meuPadrao(uid);
    const r = await db.query(
      `SELECT c.id, c.nome, c.ativo, c.comissao_total_bps, c.comissao_preposto_bps, u.login,
              (SELECT count(*) FROM pedidos p WHERE p.cliente_id = c.id)::int AS pedidos
       FROM clientes c LEFT JOIN usuarios u ON u.cliente_id = c.id AND u.papel = 'cliente'
       WHERE c.representante_id = $1 ORDER BY c.nome`, [uid]
    );
    const clientes = r.rows.map((c) => ({
      ...c,
      minha_bps: c.comissao_preposto_bps != null ? c.comissao_preposto_bps : (c.comissao_total_bps || 0),
    }));
    // acesso recem-criado (mostrado uma vez)
    let acesso = null;
    if (req.session.acessoClienteRep) { acesso = req.session.acessoClienteRep; delete req.session.acessoClienteRep; }
    res.render('rep/clientes', {
      ativo: 'rep-clientes', clientes, acesso, padrao: pad,
      erro: req.query.erro || null, ok: req.query.ok || null, formatPercent,
    });
  } catch (e) { next(e); }
});

router.post('/clientes', async (req, res, next) => {
  const client = await db.getClient();
  try {
    const uid = req.session.user.id;
    const nome = (req.body.nome || '').trim();
    const login = (req.body.login || '').trim();
    const senha = req.body.senha || '';
    const telefone = (req.body.telefone || '').toString().replace(/\D/g, '').slice(0, 15) || null;
    if (!nome || !login || !senha) throw new Error('Preencha nome, login e senha.');
    const pad = await meuPadrao(uid);
    const comissaoPrepostoBps = pad.ehPreposto ? pad.fatia : null;
    const comissaoTotalBps = pad.total;
    await client.query('BEGIN');
    const c = await client.query(
      `INSERT INTO clientes (nome, telefone, prazo_dias, representante_id, comissao_total_bps, comissao_preposto_bps)
       VALUES ($1,$2,7,$3,$4,$5) RETURNING id`,
      [nome, telefone, uid, comissaoTotalBps, comissaoPrepostoBps]
    );
    await client.query('INSERT INTO usuarios (nome, login, senha_hash, papel, cliente_id) VALUES ($1,$2,$3,$4,$5)',
      [nome, login, await bcrypt.hash(senha, 10), 'cliente', c.rows[0].id]);
    await client.query('COMMIT');
    const site = 'https://' + (req.get('host') || 'distribuidoraeea.up.railway.app');
    const nomeEmpresa = process.env.EMPRESA_NOME || 'Distribuidora E&A Móveis';
    const mensagem = [
      'Olá, ' + nome + '! Seu acesso ao sistema da ' + nomeEmpresa + ' está pronto.',
      '', 'Site: ' + site, 'Login: ' + login, 'Senha: ' + senha,
      '', 'Por lá você sobe as etiquetas e acompanha seus pedidos. Qualquer dúvida, é só chamar!',
    ].join('\n');
    req.session.acessoClienteRep = { nome, login, telefone, mensagem, site };
    res.redirect('/rep/clientes?ok=' + encodeURIComponent('Cliente "' + nome + '" cadastrado. A mensagem com o acesso está pronta abaixo.'));
  } catch (e) {
    await client.query('ROLLBACK');
    const msg = e && e.code === '23505' ? 'Login já em uso. Escolha outro.' : (e.message || 'Falha ao cadastrar o cliente.');
    res.redirect('/rep/clientes?erro=' + encodeURIComponent(msg));
  } finally { client.release(); }
});

module.exports = router;
