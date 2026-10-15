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

// Cria o lancamento dentro da transacao do pedido. Se o cliente tem credito em conta
// (sobra de pedido ja pago), ele abate o valor a pagar deste lancamento.
// Retorna { creditoUsado }.
async function criarLancamento(client, pedidoId, clienteId, valorCentavos, totalEtiquetas) {
  const c = await client.query('SELECT credito_centavos FROM clientes WHERE id = $1 FOR UPDATE', [clienteId]);
  const credito = c.rowCount ? Number(c.rows[0].credito_centavos || 0) : 0;
  const usar = Math.min(credito, valorCentavos);
  const aPagar = valorCentavos - usar;
  await client.query(
    `INSERT INTO financeiro (pedido_id, cliente_id, valor_centavos, vencimento, valor_original_centavos, etiquetas_total, credito_usado_centavos, status, pago_em, forma_pagamento)
     SELECT $1::int, $2::int, $3::int, (now() AT TIME ZONE 'America/Sao_Paulo')::date + COALESCE(c.prazo_dias, 7), $4::int, $5::int, $6::int,
            CASE WHEN $3::int = 0 THEN 'pago' ELSE 'aberto' END,
            CASE WHEN $3::int = 0 THEN now() ELSE NULL::timestamptz END,
            CASE WHEN $3::int = 0 THEN 'Crédito em conta' ELSE NULL::text END
     FROM clientes c WHERE c.id = $2
     ON CONFLICT (pedido_id) DO NOTHING`,
    [pedidoId, clienteId, aPagar, valorCentavos, totalEtiquetas || null, usar]
  );
  if (usar > 0) await client.query('UPDATE clientes SET credito_centavos = credito_centavos - $2 WHERE id = $1', [clienteId, usar]);
  return { creditoUsado: usar };
}

// Encerra um pedido com sobras: etiquetas nao despachadas viram 'nao_enviada', a cobranca
// passa a ser so das despachadas e a diferenca vira credito (libera o limite, ou credito em
// conta se o lancamento ja estava pago). Roda dentro da transacao do chamador (client).
// Retorna { despachadas, naoEnviadas, valorCobrado, creditoGerado, jaPago }.
async function encerrarPedido(client, pedidoId) {
  const p = await client.query('SELECT id, cliente_id, status, total_etiquetas FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
  if (p.rowCount === 0) throw new Error('Pedido não encontrado.');
  if (p.rows[0].status === 'despachado') throw new Error('Este pedido já está encerrado.');
  const clienteId = p.rows[0].cliente_id;

  // valor das despachadas = soma do preco da linha de cada etiqueta despachada
  const r = await client.query(
    `SELECT count(*) FILTER (WHERE e.status = 'despachado')::int AS despachadas,
            count(*) FILTER (WHERE e.status <> 'despachado')::int AS sobras,
            COALESCE(sum(l.preco_centavos) FILTER (WHERE e.status = 'despachado'), 0)::int AS valor_despachadas
     FROM etiquetas e LEFT JOIN linhas l ON l.id = e.linha_id WHERE e.pedido_id = $1`, [pedidoId]
  );
  const { despachadas, sobras, valor_despachadas } = r.rows[0];

  await client.query("UPDATE etiquetas SET status = 'nao_enviada' WHERE pedido_id = $1 AND status <> 'despachado'", [pedidoId]);
  await client.query(
    "UPDATE pedidos SET status = 'despachado', despachado_em = COALESCE(despachado_em, now()), separacao_em = COALESCE(separacao_em, now()), encerrado_em = now() WHERE id = $1",
    [pedidoId]
  );

  const f = await client.query('SELECT id, status, valor_centavos, valor_original_centavos, credito_usado_centavos FROM financeiro WHERE pedido_id = $1 FOR UPDATE', [pedidoId]);
  let creditoGerado = 0, jaPago = false;
  if (f.rowCount > 0) {
    const fin = f.rows[0];
    const original = Number(fin.valor_original_centavos !== null ? fin.valor_original_centavos : fin.valor_centavos);
    const usado = Number(fin.credito_usado_centavos || 0);
    const novoTotal = Number(valor_despachadas);           // valor do pedido apos o encerramento
    creditoGerado = Math.max(0, original - novoTotal);     // valor das etiquetas que ficaram para tras
    jaPago = fin.status === 'pago';
    if (jaPago) {
      // ja foi pago o valor cheio (a pagar = original - usado): a sobra vira credito em conta
      await client.query('UPDATE clientes SET credito_centavos = credito_centavos + $2 WHERE id = $1', [clienteId, creditoGerado]);
      await client.query('UPDATE financeiro SET etiquetas_cobradas = $2, credito_gerado_centavos = $3, encerrado_em = now() WHERE id = $1',
        [fin.id, despachadas, creditoGerado]);
    } else {
      // em aberto: a cobranca cai; o credito ja usado no aceite continua abatendo
      const novoAPagar = Math.max(0, novoTotal - usado);
      // se o credito usado no aceite era maior que o novo total, a diferenca volta para a conta
      const devolver = Math.max(0, usado - novoTotal);
      if (devolver > 0) await client.query('UPDATE clientes SET credito_centavos = credito_centavos + $2 WHERE id = $1', [clienteId, devolver]);
      await client.query(
        `UPDATE financeiro SET valor_centavos = $2, etiquetas_cobradas = $3, credito_gerado_centavos = $4, credito_usado_centavos = $5, encerrado_em = now(),
           status = CASE WHEN $2 = 0 THEN 'pago' ELSE status END,
           pago_em = CASE WHEN $2 = 0 THEN now() ELSE pago_em END,
           forma_pagamento = CASE WHEN $2 = 0 THEN COALESCE(forma_pagamento, 'Crédito em conta') ELSE forma_pagamento END
         WHERE id = $1`,
        [fin.id, novoAPagar, despachadas, creditoGerado, usado - devolver]
      );
    }
  }
  return { despachadas, naoEnviadas: sobras, valorCobrado: Number(valor_despachadas), creditoGerado, jaPago };
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
            f.valor_original_centavos, f.etiquetas_total, f.etiquetas_cobradas, f.credito_gerado_centavos, f.credito_usado_centavos,
            to_char(f.encerrado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS encerrado_em_br,
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
    // Composicao do valor: original (aceite) -> credito gerado (nao enviadas) -> credito usado -> a pagar
    l.valor_original = Number(l.valor_original_centavos !== null && l.valor_original_centavos !== undefined ? l.valor_original_centavos : l.valor_centavos);
    l.credito_gerado = Number(l.credito_gerado_centavos || 0);
    l.credito_usado = Number(l.credito_usado_centavos || 0);
    l.valor_cobrado = l.valor_original - l.credito_gerado;       // valor do pedido apos encerramento
    l.nao_enviadas = (l.etiquetas_total && l.etiquetas_cobradas !== null && l.etiquetas_cobradas !== undefined) ? l.etiquetas_total - l.etiquetas_cobradas : 0;
    l.ajustado = l.credito_gerado > 0 || l.credito_usado > 0;
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

// Credito do cliente: limite menos o que esta em aberto (inclui vencido) no financeiro.
// limite null = sem controle (disponivel = null). bloqueado = tem vencido e o cadastro manda bloquear.
async function creditoCliente(clienteId) {
  const c = await db.query('SELECT limite_centavos, bloquear_vencido, prazo_dias, credito_centavos FROM clientes WHERE id = $1', [clienteId]);
  if (c.rowCount === 0) return null;
  const cli = c.rows[0];
  const hoje = hojeISO();
  const r = await db.query(
    `SELECT f.valor_centavos, to_char(f.vencimento, 'YYYY-MM-DD') AS vencimento_iso,
            to_char(f.vencimento, 'DD/MM/YYYY') AS vencimento_br, p.numero
     FROM financeiro f JOIN pedidos p ON p.id = f.pedido_id
     WHERE f.cliente_id = $1 AND f.status = 'aberto' ORDER BY f.vencimento, f.id`, [clienteId]
  );
  let aberto = 0, vencido = 0, proximo = null, maisVencido = null;
  const abertos = [];
  for (const l of r.rows) {
    aberto += l.valor_centavos;
    abertos.push({ numero: l.numero, valor: l.valor_centavos, vencimento: l.vencimento_br, vencido: l.vencimento_iso < hoje });
    if (l.vencimento_iso < hoje) { vencido += l.valor_centavos; if (!maisVencido) maisVencido = l; }
    else if (!proximo) proximo = l;
  }
  const limite = cli.limite_centavos === null || cli.limite_centavos === undefined ? null : Number(cli.limite_centavos);
  const creditoConta = Number(cli.credito_centavos || 0);
  // disponivel = limite - em aberto + credito em conta (sobra de pedido ja pago)
  const disponivel = limite === null ? null : Math.max(0, limite - aberto + creditoConta);
  return {
    limite, aberto, vencido, disponivel, abertos, creditoConta,
    controlado: limite !== null,
    bloqueado: !!(cli.bloquear_vencido && vencido > 0),
    proximo: proximo ? { numero: proximo.numero, valor: proximo.valor_centavos, vencimento: proximo.vencimento_br } : null,
    maisVencido: maisVencido ? { numero: maisVencido.numero, valor: maisVencido.valor_centavos, vencimento: maisVencido.vencimento_br } : null,
  };
}

module.exports.creditoCliente = creditoCliente;
module.exports.encerrarPedido = encerrarPedido;

// Credito em conta (saldo a favor) de um cliente.
async function creditoConta(clienteId) {
  const r = await db.query('SELECT credito_centavos FROM clientes WHERE id = $1', [clienteId]);
  return r.rowCount ? Number(r.rows[0].credito_centavos || 0) : 0;
}
module.exports.creditoConta = creditoConta;
