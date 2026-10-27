'use strict';

// Repasses a representantes (comissao %) e funcionarios (taxa por etiqueta), por pedido.
// Base de calculo = valor cobrado do pedido (apos encerramento com sobras). O repasse so
// fica "liberado" quando o cliente paga o pedido no financeiro; o admin marca o pagamento.
//
// Preposto: um pedido pode ter DOIS ganhadores representantes:
//   - representante_id  = quem agregou (preposto, se for o caso) -> comissao_bps / rep_pago_*
//   - responsavel_id    = o representante-pai do preposto        -> comissao_resp_bps / resp_pago_*
// Na tela do representante, a pessoa ve os dois papeis (direto e "via preposto").

const db = require('./db');
const { formatBRL, formatDateTime, hojeISO } = require('./util');

const FORMAS = ['Pix', 'Transferência', 'Dinheiro', 'Outro'];

// Mantido por compatibilidade (usado so para funcionario).
function cfg(tipo) {
  return tipo === 'funcionario'
    ? { papel: 'funcionario', col: 'funcionario_id', pagoEm: 'func_pago_em', pagoForma: 'func_pago_forma', pagoVal: 'func_pago_centavos' }
    : { papel: 'representante', col: 'representante_id', pagoEm: 'rep_pago_em', pagoForma: 'rep_pago_forma', pagoVal: 'rep_pago_centavos' };
}
// Colunas por papel no repasse do representante: 'rep' (direto/preposto) ou 'resp' (pai do preposto).
function colsRep(papel) {
  return papel === 'resp'
    ? { pagoEm: 'resp_pago_em', pagoForma: 'resp_pago_forma', pagoVal: 'resp_pago_centavos' }
    : { pagoEm: 'rep_pago_em', pagoForma: 'rep_pago_forma', pagoVal: 'rep_pago_centavos' };
}

// YYYY-MM (Sao Paulo) de um timestamp.
function ymSP(d) {
  if (!d) return '';
  const s = formatDateTime(d);
  return s.slice(6, 10) + '-' + s.slice(3, 5);
}

async function pessoas(tipo) {
  if (tipo === 'funcionario') {
    const r = await db.query(
      `SELECT u.id, u.nome, u.login, u.ativo, u.comissao_bps, u.taxa_etiqueta_centavos,
              (SELECT count(*) FROM pedidos p WHERE p.funcionario_id = u.id)::int AS pedidos
       FROM usuarios u WHERE u.papel = 'funcionario' ORDER BY u.ativo DESC, u.nome`);
    return r.rows;
  }
  const r = await db.query(
    `SELECT u.id, u.nome, u.login, u.ativo, u.comissao_bps, u.taxa_etiqueta_centavos,
            u.representante_pai_id, pai.nome AS pai_nome,
            (SELECT count(*) FROM pedidos p WHERE p.representante_id = u.id OR p.responsavel_id = u.id)::int AS pedidos
     FROM usuarios u LEFT JOIN usuarios pai ON pai.id = u.representante_pai_id
     WHERE u.papel = 'representante' ORDER BY u.ativo DESC, u.nome`);
  return r.rows;
}

function situacaoDe(fin_status, venc_iso, pago_em, hoje) {
  const clientePagou = fin_status === 'pago';
  let finSit = 'aberto';
  if (clientePagou) finSit = 'pago';
  else if (fin_status === 'cancelado') finSit = 'cancelado';
  else if (venc_iso && venc_iso < hoje) finSit = 'vencido';
  let situacao = 'pendente';
  if (pago_em) situacao = 'pago';
  else if (clientePagou) situacao = 'liberado';
  return { finSit, situacao };
}
function datasRepasse(p, pago_em) {
  return {
    aceite_br: p.aceite_em ? formatDateTime(p.aceite_em).slice(0, 10) : '',
    aceite_ym: ymSP(p.aceite_em),
    pago_br: pago_em ? formatDateTime(pago_em).slice(0, 10) : '',
    pago_ym: ymSP(pago_em),
  };
}

async function listarFunc(usuarioId) {
  const r = await db.query(
    `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas, p.aceite_em, p.encerrado_em,
            p.taxa_func_centavos,
            p.func_pago_em AS pago_em, p.func_pago_forma AS pago_forma, p.func_pago_centavos AS pago_centavos,
            c.nome AS cliente_nome,
            f.status AS fin_status, f.valor_original_centavos, f.credito_gerado_centavos,
            to_char(f.vencimento, 'YYYY-MM-DD') AS venc_iso,
            u.taxa_etiqueta_centavos AS u_taxa,
            (SELECT count(*) FROM etiquetas e WHERE e.pedido_id = p.id AND e.status = 'despachado')::int AS despachadas
     FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
     LEFT JOIN financeiro f ON f.pedido_id = p.id
     LEFT JOIN usuarios u ON u.id = p.funcionario_id
     WHERE p.funcionario_id = $1 ORDER BY p.id DESC`, [usuarioId]
  );
  const hoje = hojeISO();
  return r.rows.map((p) => {
    const valorCobrado = p.valor_original_centavos != null
      ? Number(p.valor_original_centavos) - Number(p.credito_gerado_centavos || 0)
      : Number(p.total_centavos);
    const taxa = p.taxa_func_centavos != null ? Number(p.taxa_func_centavos) : Number(p.u_taxa || 0);
    const etq = p.status === 'despachado' ? Number(p.despachadas) : Number(p.total_etiquetas);
    const valor = etq * taxa;
    const base_txt = etq + ' etiq. × ' + formatBRL(taxa);
    const { finSit, situacao } = situacaoDe(p.fin_status, p.venc_iso, p.pago_em, hoje);
    return { ...p, papel_repasse: 'func', origem: '', valor_cobrado: valorCobrado, valor, base_txt, fin_sit: finSit, situacao, ...datasRepasse(p, p.pago_em) };
  });
}

async function listarRep(usuarioId) {
  const uid = Number(usuarioId);
  const r = await db.query(
    `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas, p.aceite_em, p.encerrado_em,
            p.representante_id, p.responsavel_id, p.comissao_bps, p.comissao_resp_bps,
            p.rep_pago_em, p.rep_pago_forma, p.rep_pago_centavos,
            p.resp_pago_em, p.resp_pago_forma, p.resp_pago_centavos,
            c.nome AS cliente_nome,
            f.status AS fin_status, f.valor_original_centavos, f.credito_gerado_centavos,
            to_char(f.vencimento, 'YYYY-MM-DD') AS venc_iso,
            prep.nome AS preposto_nome
     FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
     LEFT JOIN financeiro f ON f.pedido_id = p.id
     LEFT JOIN usuarios prep ON prep.id = p.representante_id
     WHERE p.representante_id = $1 OR p.responsavel_id = $1
     ORDER BY p.id DESC`, [uid]
  );
  const hoje = hojeISO();
  return r.rows.map((p) => {
    const papel = (Number(p.representante_id) === uid) ? 'rep' : 'resp';
    const bps = Number((papel === 'rep' ? p.comissao_bps : p.comissao_resp_bps) || 0);
    const pago_em = papel === 'rep' ? p.rep_pago_em : p.resp_pago_em;
    const pago_forma = papel === 'rep' ? p.rep_pago_forma : p.resp_pago_forma;
    const pago_centavos = papel === 'rep' ? p.rep_pago_centavos : p.resp_pago_centavos;
    const valorCobrado = p.valor_original_centavos != null
      ? Number(p.valor_original_centavos) - Number(p.credito_gerado_centavos || 0)
      : Number(p.total_centavos);
    const valor = Math.round(valorCobrado * bps / 10000);
    const base_txt = formatBRL(valorCobrado) + ' × ' + (bps / 100).toLocaleString('pt-BR') + '%';
    const origem = papel === 'resp' ? ('Via preposto ' + (p.preposto_nome || '')) : 'Direto';
    const { finSit, situacao } = situacaoDe(p.fin_status, p.venc_iso, pago_em, hoje);
    return {
      ...p, papel_repasse: papel, origem,
      comissao_bps: bps, pago_em, pago_forma, pago_centavos,
      valor_cobrado: valorCobrado, valor, base_txt, fin_sit: finSit, situacao,
      ...datasRepasse(p, pago_em),
    };
  });
}

async function listar(tipo, usuarioId) {
  return tipo === 'funcionario' ? listarFunc(usuarioId) : listarRep(usuarioId);
}

function resumo(rows) {
  const mes = hojeISO().slice(0, 7);
  const out = { pendente: 0, pendente_qtd: 0, liberado: 0, liberado_qtd: 0, pago: 0, pago_qtd: 0, pago_mes: 0, total: 0, qtd: rows.length };
  for (const r of rows) {
    out.total += r.valor;
    if (r.situacao === 'pendente') { out.pendente += r.valor; out.pendente_qtd++; }
    else if (r.situacao === 'liberado') { out.liberado += r.valor; out.liberado_qtd++; }
    else {
      const v = Number(r.pago_centavos != null ? r.pago_centavos : r.valor);
      out.pago += v; out.pago_qtd++;
      if (r.pago_ym === mes) out.pago_mes += v;
    }
  }
  return out;
}

function filtrar(rows, sit) {
  if (!sit || sit === 'todos') return rows;
  return rows.filter((r) => r.situacao === sit);
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function mesesDe(rows) {
  const set = new Set(rows.map((r) => r.aceite_ym).filter(Boolean));
  return Array.from(set).sort().reverse().map((ym) => ({ ym, rotulo: MESES[parseInt(ym.slice(5, 7), 10) - 1] + ' ' + ym.slice(0, 4) }));
}

// Marca o repasse de um pedido como pago (so se estiver liberado: cliente pagou).
// usuarioId define QUEM esta sendo pago (necessario para o representante, que pode ser
// o direto/preposto OU o responsavel-pai no mesmo pedido).
async function marcarPago(tipo, pedidoId, usuarioId, dataISO, forma) {
  if (tipo === 'funcionario') {
    const c = cfg('funcionario');
    const who = await db.query('SELECT funcionario_id AS uid FROM pedidos WHERE id = $1', [pedidoId]);
    if (who.rowCount === 0 || !who.rows[0].uid) throw new Error('Pedido não encontrado ou sem pessoa atribuída.');
    const lista = await listarFunc(who.rows[0].uid);
    const p = lista.find((x) => x.id === Number(pedidoId));
    validaLiberado(p);
    await db.query(
      `UPDATE pedidos SET ${c.pagoEm} = ($2::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', ${c.pagoForma} = $3, ${c.pagoVal} = $4 WHERE id = $1`,
      [pedidoId, dataISO, forma, p.valor]
    );
    return p;
  }
  const uid = Number(usuarioId);
  if (!uid) throw new Error('Representante não informado.');
  const lista = await listarRep(uid);
  const p = lista.find((x) => x.id === Number(pedidoId));
  validaLiberado(p);
  const c = colsRep(p.papel_repasse);
  await db.query(
    `UPDATE pedidos SET ${c.pagoEm} = ($2::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', ${c.pagoForma} = $3, ${c.pagoVal} = $4 WHERE id = $1`,
    [pedidoId, dataISO, forma, p.valor]
  );
  return p;
}
function validaLiberado(p) {
  if (!p) throw new Error('Pedido não encontrado.');
  if (p.situacao === 'pago') throw new Error('Este repasse já está pago.');
  if (p.situacao !== 'liberado') throw new Error('O cliente ainda não pagou este pedido; o repasse não está liberado.');
}

async function reabrir(tipo, pedidoId, usuarioId) {
  if (tipo === 'funcionario') {
    const c = cfg('funcionario');
    await db.query(`UPDATE pedidos SET ${c.pagoEm} = NULL, ${c.pagoForma} = NULL, ${c.pagoVal} = NULL WHERE id = $1`, [pedidoId]);
    return;
  }
  // descobre o papel da pessoa neste pedido para reabrir a coluna certa
  const pr = await db.query('SELECT representante_id, responsavel_id FROM pedidos WHERE id = $1', [pedidoId]);
  if (pr.rowCount === 0) return;
  const uid = Number(usuarioId);
  const papel = Number(pr.rows[0].representante_id) === uid ? 'rep' : (Number(pr.rows[0].responsavel_id) === uid ? 'resp' : null);
  if (!papel) return;
  const c = colsRep(papel);
  await db.query(`UPDATE pedidos SET ${c.pagoEm} = NULL, ${c.pagoForma} = NULL, ${c.pagoVal} = NULL WHERE id = $1`, [pedidoId]);
}

async function pagarLiberados(tipo, usuarioId, dataISO, forma) {
  const lista = await listar(tipo, usuarioId);
  let n = 0, total = 0;
  for (const p of lista) {
    if (p.situacao !== 'liberado') continue;
    await marcarPago(tipo, p.id, usuarioId, dataISO, forma);
    n++; total += p.valor;
  }
  return { n, total };
}

module.exports = { FORMAS, cfg, pessoas, listar, resumo, filtrar, mesesDe, marcarPago, reabrir, pagarLiberados };
