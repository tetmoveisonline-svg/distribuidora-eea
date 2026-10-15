'use strict';

// Financeiro por pedido: cada pedido aceito gera um lancamento (valor = total do pedido,
// vencimento = aceite + prazo do cliente). O admin marca como pago manualmente.

const db = require('./db');

const FORMAS = ['Pix', 'Boleto', 'Transferência', 'Dinheiro', 'Cartão', 'Outro'];

// Data de hoje em Sao Paulo no formato YYYY-MM-DD (para comparar com o vencimento).
function hojeISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function mesAtual() { return hojeISO().slice(0, 7); }

// Cria o lancamento dentro da transacao do pedido.
async function criarLancamento(client, pedidoId, clienteId, valorCentavos) {
  await client.query(
    `INSERT INTO financeiro (pedido_id, cliente_id, valor_centavos, vencimento)
     SELECT $1, $2, $3, (now() AT TIME ZONE 'America/Sao_Paulo')::date + COALESCE(c.prazo_dias, 7)
     FROM clientes c WHERE c.id = $2
     ON CONFLICT (pedido_id) DO NOTHING`,
    [pedidoId, clienteId, valorCentavos]
  );
}

// Situacao exibida: aberto | vencido | pago | cancelado.
function situacao(l, hoje) {
  if (l.status === 'pago' || l.status === 'cancelado') return l.status;
  return (l.vencimento_iso < (hoje || hojeISO())) ? 'vencido' : 'aberto';
}

function diasAtraso(l, hoje) {
  const a = new Date(l.vencimento_iso + 'T00:00:00Z').getTime();
  const b = new Date((hoje || hojeISO()) + 'T00:00:00Z').getTime();
  return Math.max(0, Math.round((b - a) / 86400000));
}

// Lista lancamentos com dados do pedido. Filtros: clienteId, mes (YYYY-MM do vencimento).
async function listar(f) {
  f = f || {};
  const where = [], params = [];
  if (f.clienteId) { params.push(f.clienteId); where.push('f.cliente_id = $' + params.length); }
  if (f.mes) { params.push(f.mes); where.push("to_char(f.vencimento, 'YYYY-MM') = $" + params.length); }
  const r = await db.query(
    `SELECT f.id, f.pedido_id, f.cliente_id, f.valor_centavos, f.status, f.pago_em, f.forma_pagamento, f.observacao,
            to_char(f.vencimento, 'YYYY-MM-DD') AS vencimento_iso,
            to_char(f.vencimento, 'DD/MM/YYYY') AS vencimento_br,
            to_char(f.pago_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS pago_em_br,
            to_char(f.pago_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS pago_mes,
            p.numero, p.total_etiquetas, p.aceite_em, c.nome AS cliente_nome
     FROM financeiro f
     JOIN pedidos p ON p.id = f.pedido_id
     JOIN clientes c ON c.id = f.cliente_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY f.vencimento DESC, f.id DESC`, params
  );
  const hoje = hojeISO();
  const lancs = r.rows.map((l) => ({ ...l, situacao: situacao(l, hoje), dias_atraso: diasAtraso(l, hoje) }));

  // Linhas (itens) de cada pedido, para o detalhe "o que gerou o valor".
  const ids = lancs.map((l) => l.pedido_id);
  const linhasMap = new Map();
  if (ids.length > 0) {
    const lr = await db.query(
      'SELECT pedido_id, item_nome, quantidade, preco_centavos, total_centavos FROM linhas WHERE pedido_id = ANY($1::int[]) ORDER BY id', [ids]
    );
    for (const row of lr.rows) {
      if (!linhasMap.has(row.pedido_id)) linhasMap.set(row.pedido_id, []);
      linhasMap.get(row.pedido_id).push(row);
    }
  }
  lancs.forEach((l) => {
    l.linhas = linhasMap.get(l.pedido_id) || [];
    l.itens_resumo = l.linhas.map((x) => x.item_nome + ' ' + x.quantidade).join(' · ') || '—';
  });
  return lancs;
}

// Totais para os cards do topo (calculados sobre a lista completa do cliente/filtro).
function resumo(lancs) {
  const mes = mesAtual();
  const out = { aberto_centavos: 0, aberto_qtd: 0, vencido_centavos: 0, vencido_qtd: 0, vencido_dias: 0,
    pago_mes_centavos: 0, pago_mes_qtd: 0, proximo: null };
  for (const l of lancs) {
    if (l.situacao === 'aberto' || l.situacao === 'vencido') { out.aberto_centavos += l.valor_centavos; out.aberto_qtd++; }
    if (l.situacao === 'vencido') {
      out.vencido_centavos += l.valor_centavos; out.vencido_qtd++;
      out.vencido_dias = Math.max(out.vencido_dias, l.dias_atraso);
    }
    if (l.situacao === 'pago' && l.pago_mes === mes) { out.pago_mes_centavos += l.valor_centavos; out.pago_mes_qtd++; }
    if (l.situacao === 'aberto' && (!out.proximo || l.vencimento_iso < out.proximo.vencimento_iso)) out.proximo = l;
  }
  return out;
}

// Filtro de situacao aplicado depois (porque "vencido" e calculado).
function filtrarSituacao(lancs, s) {
  if (!s || s === 'todos') return lancs;
  if (s === 'aberto') return lancs.filter((l) => l.situacao === 'aberto' || l.situacao === 'vencido');
  return lancs.filter((l) => l.situacao === s);
}

// Meses disponiveis para o filtro (YYYY-MM -> rotulo).
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
function rotuloMes(ym) {
  if (!ym || ym.length < 7) return ym || '';
  const m = parseInt(ym.slice(5, 7), 10);
  return (MESES[m - 1] || ym) + ' ' + ym.slice(0, 4);
}
async function mesesDisponiveis(clienteId) {
  const params = [];
  let where = '';
  if (clienteId) { params.push(clienteId); where = 'WHERE cliente_id = $1'; }
  const r = await db.query(`SELECT DISTINCT to_char(vencimento, 'YYYY-MM') AS ym FROM financeiro ${where} ORDER BY ym DESC`, params);
  return r.rows.map((x) => ({ ym: x.ym, rotulo: rotuloMes(x.ym) }));
}

module.exports = { FORMAS, hojeISO, mesAtual, criarLancamento, listar, resumo, filtrarSituacao, mesesDisponiveis, rotuloMes };
