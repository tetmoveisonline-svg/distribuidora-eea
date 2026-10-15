'use strict';

// Repasses a representantes (comissao %) e funcionarios (taxa por etiqueta), por pedido.
// Base de calculo = valor cobrado do pedido (apos encerramento com sobras). O repasse so
// fica "liberado" quando o cliente paga o pedido no financeiro; o admin marca o pagamento.

const db = require('./db');
const { formatBRL, formatDateTime, hojeISO } = require('./util');

const FORMAS = ['Pix', 'Transferência', 'Dinheiro', 'Outro'];

function cfg(tipo) {
  return tipo === 'funcionario'
    ? { papel: 'funcionario', col: 'funcionario_id', pagoEm: 'func_pago_em', pagoForma: 'func_pago_forma', pagoVal: 'func_pago_centavos' }
    : { papel: 'representante', col: 'representante_id', pagoEm: 'rep_pago_em', pagoForma: 'rep_pago_forma', pagoVal: 'rep_pago_centavos' };
}

// YYYY-MM (Sao Paulo) de um timestamp.
function ymSP(d) {
  if (!d) return '';
  const s = formatDateTime(d); // dd/mm/aaaa hh:mm
  return s.slice(6, 10) + '-' + s.slice(3, 5);
}

async function pessoas(tipo) {
  const c = cfg(tipo);
  const r = await db.query(
    `SELECT u.id, u.nome, u.login, u.ativo, u.comissao_bps, u.taxa_etiqueta_centavos,
            (SELECT count(*) FROM pedidos p WHERE p.${c.col} = u.id)::int AS pedidos
     FROM usuarios u WHERE u.papel = $1 ORDER BY u.ativo DESC, u.nome`, [c.papel]
  );
  return r.rows;
}

// Pedidos de uma pessoa com o repasse calculado e a situacao.
async function listar(tipo, usuarioId) {
  const c = cfg(tipo);
  const r = await db.query(
    `SELECT p.id, p.numero, p.status, p.total_centavos, p.total_etiquetas, p.aceite_em, p.encerrado_em,
            p.comissao_bps, p.taxa_func_centavos,
            p.${c.pagoEm} AS pago_em, p.${c.pagoForma} AS pago_forma, p.${c.pagoVal} AS pago_centavos,
            c.nome AS cliente_nome,
            f.status AS fin_status, f.valor_original_centavos, f.credito_gerado_centavos,
            to_char(f.vencimento, 'YYYY-MM-DD') AS venc_iso, to_char(f.vencimento, 'DD/MM/YYYY') AS venc_br,
            to_char(f.pago_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS fin_pago_br,
            u.comissao_bps AS u_bps, u.taxa_etiqueta_centavos AS u_taxa,
            (SELECT count(*) FROM etiquetas e WHERE e.pedido_id = p.id AND e.status = 'despachado')::int AS despachadas
     FROM pedidos p
     JOIN clientes c ON c.id = p.cliente_id
     LEFT JOIN financeiro f ON f.pedido_id = p.id
     LEFT JOIN usuarios u ON u.id = p.${c.col}
     WHERE p.${c.col} = $1
     ORDER BY p.id DESC`, [usuarioId]
  );
  const hoje = hojeISO();
  return r.rows.map((p) => {
    const valorCobrado = p.valor_original_centavos !== null && p.valor_original_centavos !== undefined
      ? Number(p.valor_original_centavos) - Number(p.credito_gerado_centavos || 0)
      : Number(p.total_centavos);
    let valor, base_txt;
    if (tipo === 'funcionario') {
      const taxa = p.taxa_func_centavos !== null && p.taxa_func_centavos !== undefined ? Number(p.taxa_func_centavos) : Number(p.u_taxa || 0);
      const etq = p.status === 'despachado' ? Number(p.despachadas) : Number(p.total_etiquetas);
      valor = etq * taxa;
      base_txt = etq + ' etiq. × ' + formatBRL(taxa);
    } else {
      const bps = p.comissao_bps !== null && p.comissao_bps !== undefined ? Number(p.comissao_bps) : Number(p.u_bps || 0);
      valor = Math.round(valorCobrado * bps / 10000);
      base_txt = formatBRL(valorCobrado) + ' × ' + (bps / 100).toLocaleString('pt-BR') + '%';
    }
    const clientePagou = p.fin_status === 'pago';
    let finSit = 'aberto';
    if (clientePagou) finSit = 'pago';
    else if (p.fin_status === 'cancelado') finSit = 'cancelado';
    else if (p.venc_iso && p.venc_iso < hoje) finSit = 'vencido';
    let situacao = 'pendente';
    if (p.pago_em) situacao = 'pago';
    else if (clientePagou) situacao = 'liberado';
    return {
      ...p, valor_cobrado: valorCobrado, valor, base_txt, fin_sit: finSit, situacao,
      aceite_br: p.aceite_em ? formatDateTime(p.aceite_em).slice(0, 10) : '',
      aceite_ym: ymSP(p.aceite_em),
      pago_br: p.pago_em ? formatDateTime(p.pago_em).slice(0, 10) : '',
      pago_ym: ymSP(p.pago_em),
    };
  });
}

function resumo(rows) {
  const mes = hojeISO().slice(0, 7);
  const out = { pendente: 0, pendente_qtd: 0, liberado: 0, liberado_qtd: 0, pago: 0, pago_qtd: 0, pago_mes: 0, total: 0, qtd: rows.length };
  for (const r of rows) {
    out.total += r.valor;
    if (r.situacao === 'pendente') { out.pendente += r.valor; out.pendente_qtd++; }
    else if (r.situacao === 'liberado') { out.liberado += r.valor; out.liberado_qtd++; }
    else {
      const v = Number(r.pago_centavos !== null && r.pago_centavos !== undefined ? r.pago_centavos : r.valor);
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
async function marcarPago(tipo, pedidoId, dataISO, forma) {
  const c = cfg(tipo);
  const who = await db.query(`SELECT ${c.col} AS uid FROM pedidos WHERE id = $1`, [pedidoId]);
  if (who.rowCount === 0 || !who.rows[0].uid) throw new Error('Pedido não encontrado ou sem pessoa atribuída.');
  const lista = await listar(tipo, who.rows[0].uid);
  const p = lista.find((x) => x.id === Number(pedidoId));
  if (!p) throw new Error('Pedido não encontrado.');
  if (p.situacao === 'pago') throw new Error('Este repasse já está pago.');
  if (p.situacao !== 'liberado') throw new Error('O cliente ainda não pagou este pedido; o repasse não está liberado.');
  await db.query(
    `UPDATE pedidos SET ${c.pagoEm} = ($2::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', ${c.pagoForma} = $3, ${c.pagoVal} = $4 WHERE id = $1`,
    [pedidoId, dataISO, forma, p.valor]
  );
  return p;
}
async function reabrir(tipo, pedidoId) {
  const c = cfg(tipo);
  await db.query(`UPDATE pedidos SET ${c.pagoEm} = NULL, ${c.pagoForma} = NULL, ${c.pagoVal} = NULL WHERE id = $1`, [pedidoId]);
}
async function pagarLiberados(tipo, usuarioId, dataISO, forma) {
  const lista = await listar(tipo, usuarioId);
  let n = 0, total = 0;
  for (const p of lista) {
    if (p.situacao !== 'liberado') continue;
    await marcarPago(tipo, p.id, dataISO, forma);
    n++; total += p.valor;
  }
  return { n, total };
}

module.exports = { FORMAS, cfg, pessoas, listar, resumo, filtrar, mesesDe, marcarPago, reabrir, pagarLiberados };
