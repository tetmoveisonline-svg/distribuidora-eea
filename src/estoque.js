'use strict';

// Estoque por cor (SKU) com reserva.
//   saldo     = fisico (o que esta no deposito)
//   reservado = comprometido com pedidos aceitos e ainda nao despachados
//   disponivel = saldo - reservado (o que o cliente ve e pode pedir)
// Aceite reserva, despacho consome (saldo -1, reservado -1), encerramento com sobras libera a reserva.
// Todo movimento vira uma linha em estoque_mov.

const db = require('./db');

const MOTIVOS = ['Entrada', 'Ajuste', 'Saída manual'];

// Movimenta dentro de uma transacao (client).
//   m.quantidade: delta do fisico (+entra / -sai); m.reserva: delta do reservado.
async function movimentar(client, m) {
  const q = Number(m.quantidade || 0), r = Number(m.reserva || 0);
  if (!q && !r) return null;
  let saldo, reservado, antes;
  if (m.corId) {
    const b = await client.query('SELECT saldo - reservado AS d FROM produto_cores WHERE id = $1', [m.corId]); antes = b.rowCount ? Number(b.rows[0].d) : null;
    const x = await client.query('UPDATE produto_cores SET saldo = saldo + $2, reservado = GREATEST(0, reservado + $3) WHERE id = $1 AND produto_id = $4 RETURNING saldo, reservado, nome', [m.corId, q, r, m.produtoId]);
    if (x.rowCount === 0) return null;
    saldo = x.rows[0].saldo; reservado = x.rows[0].reservado; m.corNome = m.corNome || x.rows[0].nome;
  } else {
    const b = await client.query('SELECT saldo - reservado AS d FROM produtos WHERE id = $1', [m.produtoId]); antes = b.rowCount ? Number(b.rows[0].d) : null;
    const x = await client.query('UPDATE produtos SET saldo = saldo + $2, reservado = GREATEST(0, reservado + $3) WHERE id = $1 RETURNING saldo, reservado', [m.produtoId, q, r]);
    if (x.rowCount === 0) return null;
    saldo = x.rows[0].saldo; reservado = x.rows[0].reservado;
  }
  // Novidades para os clientes: estoque reposto (saiu de <=5 para >5) ou esgotou (saiu de >0 para <=0)
  try {
    const depois = saldo - reservado;
    const nome = await client.query('SELECT nome FROM produtos WHERE id = $1', [m.produtoId]);
    const rot = (nome.rowCount ? nome.rows[0].nome : 'Produto') + (m.corNome ? ' · ' + m.corNome : '');
    const nov = require('./novidades');
    if (antes !== null && antes <= 5 && depois > 5 && q > 0) await nov.registrarUnico(client, { tipo: 'reposto', produtoId: m.produtoId, titulo: rot + ' reposto', detalhe: antes + ' → ' + depois + ' disponíveis' }, 120);
    else if (antes !== null && antes > 0 && depois <= 0) await nov.registrarUnico(client, { tipo: 'esgotou', produtoId: m.produtoId, titulo: rot + ' esgotou', detalhe: 'avisamos quando repor' }, 120);
  } catch (e) { /* feed nao pode travar o estoque */ }
  await client.query(
    `INSERT INTO estoque_mov (produto_id, cor_id, cor_nome, quantidade, reserva, saldo_apos, reservado_apos, motivo, observacao, pedido_id, etiqueta_id, linha_id, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [m.produtoId, m.corId || null, m.corNome || null, q, r, saldo, reservado, m.motivo || 'Ajuste', m.observacao || null, m.pedidoId || null, m.etiquetaId || null, m.linhaId || null, m.usuarioId || null]
  );
  return { saldo, reservado, disponivel: saldo - reservado };
}

// Linhas de um pedido com produto/cor resolvidos.
async function linhasDoPedido(client, pedidoId) {
  const r = await client.query(
    `SELECT l.id, l.quantidade, l.cor_id, l.cor_nome, i.produto_id,
            (SELECT count(*) FROM etiquetas e WHERE e.linha_id = l.id AND e.status = 'despachado')::int AS despachadas,
            (SELECT count(*) FROM etiquetas e WHERE e.linha_id = l.id AND e.status = 'nao_enviada')::int AS nao_enviadas
     FROM linhas l LEFT JOIN itens i ON i.id = l.item_id WHERE l.pedido_id = $1 ORDER BY l.id`, [pedidoId]
  );
  return r.rows.filter((l) => l.produto_id);
}

// Aceite: reserva a quantidade de cada linha.
async function reservarPedido(client, pedidoId, usuarioId) {
  for (const l of await linhasDoPedido(client, pedidoId)) {
    await movimentar(client, { produtoId: l.produto_id, corId: l.cor_id, corNome: l.cor_nome, quantidade: 0, reserva: l.quantidade, motivo: 'Reserva', pedidoId, linhaId: l.id, usuarioId });
  }
}

// Despacho: consome 1 do fisico e 1 da reserva pela etiqueta despachada.
async function baixarEtiqueta(client, etiquetaId, usuarioId) {
  const r = await client.query(
    `SELECT e.id, e.pedido_id, e.linha_id, l.cor_id, l.cor_nome, i.produto_id
     FROM etiquetas e JOIN linhas l ON l.id = e.linha_id LEFT JOIN itens i ON i.id = l.item_id
     WHERE e.id = $1`, [etiquetaId]
  );
  if (r.rowCount === 0 || !r.rows[0].produto_id) return null;
  const x = r.rows[0];
  return movimentar(client, { produtoId: x.produto_id, corId: x.cor_id, corNome: x.cor_nome, quantidade: -1, reserva: -1, motivo: 'Despacho', pedidoId: x.pedido_id, etiquetaId: x.id, linhaId: x.linha_id, usuarioId });
}

// Encerramento com sobras: libera a reserva das etiquetas nao enviadas.
async function liberarReservaPedido(client, pedidoId, usuarioId) {
  for (const l of await linhasDoPedido(client, pedidoId)) {
    if (l.nao_enviadas > 0) {
      await movimentar(client, { produtoId: l.produto_id, corId: l.cor_id, corNome: l.cor_nome, quantidade: 0, reserva: -l.nao_enviadas, motivo: 'Liberação de reserva', observacao: l.nao_enviadas + ' não enviada(s)', pedidoId, linhaId: l.id, usuarioId });
    }
  }
}

// Catalogo do cliente (todos os produtos ativos com preco: negociado ou sugerido), com o
// disponivel por cor e o reservado para os pedidos dele.
async function saldosParaCliente(clienteId) {
  const { formatBRL } = require('./util');
  const cat = await require('./precos').catalogoDoCliente(db, clienteId);
  // reservado para este cliente: linhas de pedidos abertos dele, por cor (ou produto)
  const mine = await db.query(
    `SELECT l.cor_id, i.produto_id, string_agg(DISTINCT pe.numero, ', ') AS pedidos,
            sum(l.quantidade - (SELECT count(*) FROM etiquetas e WHERE e.linha_id = l.id AND e.status = 'despachado'))::int AS reservado
     FROM linhas l JOIN pedidos pe ON pe.id = l.pedido_id LEFT JOIN itens i ON i.id = l.item_id
     WHERE pe.cliente_id = $1 AND pe.status <> 'despachado' AND i.produto_id IS NOT NULL
     GROUP BY l.cor_id, i.produto_id`, [clienteId]
  );
  const mineMap = new Map(mine.rows.map((x) => [(x.produto_id) + ':' + (x.cor_id || 0), x]));
  return cat.map((x) => {
    const m = mineMap.get(x.produto_id + ':0');
    return { id: x.produto_id, nome: x.nome, descricao: x.descricao, obs: x.obs || '', saldo: x.fisico, reservado: x.reservado, disponivel: x.saldo,
      meu_reservado: m ? m.reservado : 0, meus_pedidos: m ? m.pedidos : '', origem: x.origem,
      preco_centavos: x.preco_centavos, preco_original: x.preco_original, promo: x.promo, promo_rotulo: x.promo_rotulo,
      preco_txt: formatBRL(x.preco_centavos), preco_original_txt: formatBRL(x.preco_original),
      cores: x.cores.map((c) => { const mc = mineMap.get(x.produto_id + ':' + c.id); return { id: c.id, nome: c.nome, sku: c.sku, saldo: c.fisico, reservado: c.reservado, disponivel: c.saldo, meu_reservado: mc ? mc.reservado : 0, meus_pedidos: mc ? mc.pedidos : '' }; }) };
  });
}
// Catalogo com PRECO SUGERIDO (sem vinculo a nenhum cliente), para o representante/preposto
// ver o estoque do mesmo jeito que o cliente ve, mas com os precos sugeridos e sem reservas pessoais.
async function saldosSugerido() {
  const { formatBRL } = require('./util');
  const cat = await require('./precos').catalogoDoCliente(db, null);
  return cat.map((x) => ({
    id: x.produto_id, nome: x.nome, descricao: x.descricao, obs: x.obs || '',
    saldo: x.fisico, reservado: x.reservado, disponivel: x.saldo,
    meu_reservado: 0, meus_pedidos: '', origem: x.origem,
    preco_centavos: x.preco_centavos, preco_original: x.preco_original, promo: x.promo, promo_rotulo: x.promo_rotulo,
    preco_txt: formatBRL(x.preco_centavos), preco_original_txt: formatBRL(x.preco_original),
    cores: x.cores.map((c) => ({ id: c.id, nome: c.nome, sku: c.sku, saldo: c.fisico, reservado: c.reservado, disponivel: c.saldo, meu_reservado: 0, meus_pedidos: '' })),
  }));
}
async function saldosTodos() {
  const p = await db.query('SELECT id, nome, descricao, saldo, reservado, (saldo - reservado) AS disponivel, ativo FROM produtos ORDER BY nome');
  return anexarCores(p.rows);
}
async function anexarCores(produtos) {
  const ids = produtos.map((x) => x.id);
  const map = new Map();
  if (ids.length) {
    const c = await db.query('SELECT id, produto_id, nome, sku, saldo, reservado, (saldo - reservado) AS disponivel FROM produto_cores WHERE produto_id = ANY($1::int[]) ORDER BY ordem, id', [ids]);
    for (const row of c.rows) { if (!map.has(row.produto_id)) map.set(row.produto_id, []); map.get(row.produto_id).push(row); }
  }
  return produtos.map((x) => ({ ...x, cores: map.get(x.id) || [] }));
}

async function historico(f) {
  f = f || {};
  const where = [], params = [];
  if (f.produtoId) { params.push(f.produtoId); where.push('m.produto_id = $' + params.length); }
  params.push(f.limite || 200);
  const r = await db.query(
    `SELECT m.*, p.nome AS produto_nome, u.nome AS usuario_nome, pe.numero AS pedido_numero
     FROM estoque_mov m JOIN produtos p ON p.id = m.produto_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN pedidos pe ON pe.id = m.pedido_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY m.id DESC LIMIT $${params.length}`, params
  );
  return r.rows;
}

module.exports = { MOTIVOS, movimentar, reservarPedido, baixarEtiqueta, liberarReservaPedido, saldosParaCliente, saldosSugerido, saldosTodos, historico };
