'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { exigeRepresentante } = require('../auth');
const estoque = require('../estoque');
const imagens = require('../imagens');
const repasses = require('../repasses');
const { formatBRL, formatDateTime, formatPercent, andamentoDisplay, montarMensagemAcesso, hojeISO, brDate } = require('../util');

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
    const pad = await meuPadrao(uid);
    // O representante ve os pedidos onde ele e o representante direto (ou preposto) E tambem
    // aqueles em que ele e o responsavel-pai de um preposto (recebe a fatia dele nesses).
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas,
              p.representante_id, p.responsavel_id,
              p.aceite_em, p.criado_em, p.separacao_em, p.preparando_em, p.despachado_em,
              c.nome AS cliente_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       WHERE p.representante_id = $1 OR p.responsavel_id = $1
       ORDER BY p.id DESC`, [uid]
    );
    // Comissao e situacao vem do MESMO calculo do painel de repasses do admin (valor cobrado x %,
    // pendente / liberado / pago), para os numeros do representante baterem com o que sera pago.
    const rep = await repasses.listar('representante', uid);
    const repMap = new Map(rep.map((x) => [x.id, x]));
    const ids = r.rows.map((p) => p.id);
    const finMap = new Map();
    if (ids.length > 0) {
      const fr = await db.query('SELECT pedido_id, pago_em FROM financeiro WHERE pedido_id = ANY($1::int[])', [ids]);
      for (const x of fr.rows) finMap.set(x.pedido_id, x);
    }
    const taxaRef = await taxaFuncRef();
    const todos = r.rows.filter((p) => repMap.has(p.id)).map((p) => {
      const x = repMap.get(p.id);
      const pagoValor = x.situacao === 'pago' && x.pago_centavos != null ? Number(x.pago_centavos) : x.valor;
      const f = finMap.get(p.id);
      let comSub = '';
      if (x.situacao === 'pago') comSub = (x.pago_br || '') + (x.pago_forma ? ' · ' + x.pago_forma : '');
      else if (x.situacao === 'liberado') comSub = f && f.pago_em ? 'cliente pagou em ' + formatDateTime(f.pago_em).slice(0, 5) : 'cliente pagou';
      else if (x.fin_sit === 'cancelado') comSub = 'pedido cancelado';
      else if (x.venc_iso) comSub = (x.fin_sit === 'vencido' ? 'venceu ' : 'vence ') + brDate(x.venc_iso);
      return {
        ...p,
        eh_resp: x.papel_repasse === 'resp', origem: x.origem,
        minha_bps: x.comissao_bps, minha_comissao: pagoValor, valor_cobrado: x.valor_cobrado,
        situacao: x.situacao, fin_sit: x.fin_sit, com_sub: comSub, aceite_ym: x.aceite_ym, pago_ym: x.pago_ym,
        taxa_func_centavos: taxaRef !== null ? taxaRef * p.total_etiquetas : null,
        passos: andamentoDisplay(p),
      };
    });

    // Cartoes: sobre todos os pedidos (como no painel do admin).
    const mesAtual = hojeISO().slice(0, 7);
    const kp = { pendente: 0, pendente_qtd: 0, liberado: 0, liberado_qtd: 0, pago_mes: 0, pago_mes_qtd: 0, total: 0, vendas: 0, qtd: todos.length };
    for (const p of todos) {
      kp.total += p.minha_comissao; kp.vendas += p.valor_cobrado;
      if (p.situacao === 'pendente') { kp.pendente += p.minha_comissao; kp.pendente_qtd++; }
      else if (p.situacao === 'liberado') { kp.liberado += p.minha_comissao; kp.liberado_qtd++; }
      else if (p.pago_ym === mesAtual) { kp.pago_mes += p.minha_comissao; kp.pago_mes_qtd++; }
    }
    const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    kp.mes_nome = MESES[parseInt(mesAtual.slice(5, 7), 10) - 1];

    // Filtros: mes (do aceite) e situacao.
    const sit = ['todos', 'pendente', 'liberado', 'pago'].includes(req.query.sit) ? req.query.sit : 'todos';
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : '';
    const doMes = mes ? todos.filter((p) => p.aceite_ym === mes) : todos;
    const contagem = { todos: doMes.length, pendente: 0, liberado: 0, pago: 0 };
    doMes.forEach((p) => { contagem[p.situacao]++; });
    const pedidos = sit === 'todos' ? doMes : doMes.filter((p) => p.situacao === sit);
    const meses = repasses.mesesDe(rep);

    // Detalhe por etiqueta (situacao + horario do bipe) dos pedidos exibidos, numa unica consulta.
    const idsVis = pedidos.map((p) => p.id);
    const etqMap = new Map();
    if (idsVis.length > 0) {
      const er = await db.query(
        `SELECT e.pedido_id, e.indice, e.status, e.despachado_em, l.item_nome
         FROM etiquetas e LEFT JOIN linhas l ON l.id = e.linha_id
         WHERE e.pedido_id = ANY($1::int[]) ORDER BY e.pedido_id, e.indice`, [idsVis]
      );
      for (const row of er.rows) {
        if (!etqMap.has(row.pedido_id)) etqMap.set(row.pedido_id, []);
        etqMap.get(row.pedido_id).push(row);
      }
    }
    pedidos.forEach((p) => {
      const arr = etqMap.get(p.id) || [];
      p.etiquetas = arr;
      p.etqDespachadas = arr.filter((e) => e.status === 'despachado').length;
      p.etqTotal = arr.length;
    });

    res.render('rep/pedidos', {
      pedidos, ativo: 'rep', ehPreposto: pad.ehPreposto,
      kp, contagem, meses, filtro: { sit, mes },
      temTaxaFunc: taxaRef !== null,
      formatBRL, formatDateTime, formatPercent,
    });
  } catch (e) { next(e); }
});

// ===================== ESTOQUE (preco sugerido, como o cliente ve) =====================
router.get('/estoque', async (req, res, next) => {
  try {
    const produtos = await imagens.anexar(await estoque.saldosSugerido());
    res.render('cliente/estoque', { produtos, ativo: 'rep-estoque', apiUrl: '/rep/api/estoque', sugerido: true, formatDateTime });
  } catch (e) { next(e); }
});
router.get('/api/estoque', async (req, res) => {
  try {
    const produtos = await imagens.anexar(await estoque.saldosSugerido());
    res.json({ ok: true, produtos, atualizado_em: formatDateTime(new Date()) });
  } catch (e) { console.error('Erro estoque rep:', e); res.status(500).json({ erro: 'Falha ao carregar o estoque.' }); }
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
    const nomeEmpresa = process.env.EMPRESA_NOME || 'A4 Móveis Distribuidora';
    const manualUrl = process.env.MANUAL_CLIENTE_URL || null;
    const mensagem = montarMensagemAcesso({ nome, login, senha, site, empresa: nomeEmpresa, manualUrl });
    req.session.acessoClienteRep = { nome, login, telefone, mensagem, site };
    res.redirect('/rep/clientes?ok=' + encodeURIComponent('Cliente "' + nome + '" cadastrado. A mensagem com o acesso está pronta abaixo.'));
  } catch (e) {
    await client.query('ROLLBACK');
    const msg = e && e.code === '23505' ? 'Login já em uso. Escolha outro.' : (e.message || 'Falha ao cadastrar o cliente.');
    res.redirect('/rep/clientes?erro=' + encodeURIComponent(msg));
  } finally { client.release(); }
});

module.exports = router;
