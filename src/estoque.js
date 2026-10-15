'use strict';

// Estoque por cor (SKU). Saldo fica em produto_cores.saldo (ou produtos.saldo para cor unica);
// todo movimento vira uma linha em estoque_mov. A bipagem baixa 1 por etiqueta despachada.

const db = require('./db');

const MOTIVOS = ['Entrada', 'Ajuste', 'Saída manual'];

// Movimenta o saldo dentro de uma transacao (client). quantidade: +entra / -sai.
async function movimentar(client, m) {
  const q = Number(m.quantidade || 0);
  if (!q) return null;
  let saldo;
  if (m.corId) {
    const r = await client.query('UPDATE produto_cores SET saldo = saldo + $2 WHERE id = $1 AND produto_id = $3 RETURNING saldo, nome', [m.corId, q, m.produtoId]);
    if (r.rowCount === 0) return null;
    saldo = r.rows[0].saldo; m.corNome = m.corNome || r.rows[0].nome;
  } else {
    const r = await client.query('UPDATE produtos SET saldo = saldo + $2 WHERE id = $1 RETURNING saldo', [m.produtoId, q]);
    if (r.rowCount === 0) return null;
    saldo = r.rows[0].saldo;
  }
  await client.query(
    `INSERT INTO estoque_mov (produto_id, cor_id, cor_nome, quantidade, saldo_apos, motivo, observacao, pedido_id, etiqueta_id, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [m.produtoId, m.corId || null, m.corNome || null, q, saldo, m.motivo || 'Ajuste', m.observacao || null, m.pedidoId || null, m.etiquetaId || null, m.usuarioId || null]
  );
  return saldo;
}

// Baixa 1 unidade pela etiqueta despachada (resolve produto/cor pela linha do pedido).
async function baixarEtiqueta(client, etiquetaId, usuarioId) {
  const r = await client.query(
    `SELECT e.id, e.pedido_id, l.cor_id, l.cor_nome, i.produto_id
     FROM etiquetas e JOIN linhas l ON l.id = e.linha_id LEFT JOIN itens i ON i.id = l.item_id
     WHERE e.id = $1`, [etiquetaId]
  );
  if (r.rowCount === 0 || !r.rows[0].produto_id) return null; // item apagado: sem estoque para baixar
  const x = r.rows[0];
  return movimentar(client, { produtoId: x.produto_id, corId: x.cor_id, corNome: x.cor_nome, quantidade: -1, motivo: 'Despacho', pedidoId: x.pedido_id, etiquetaId: x.id, usuarioId });
}

// Saldos dos produtos que o cliente tem preco negociado: [{ produto, cores:[{nome, sku, saldo}] | saldo }]
async function saldosParaCliente(clienteId) {
  const { precoEfetivo, formatBRL } = require('./util');
  const p = await db.query(
    `SELECT DISTINCT ON (p.id) p.id, p.nome, p.descricao, p.saldo,
            i.preco_centavos, i.promo_tipo, i.promo_valor,
            to_char(i.promo_inicio, 'YYYY-MM-DD') AS promo_inicio, to_char(i.promo_fim, 'YYYY-MM-DD') AS promo_fim
     FROM itens i JOIN produtos p ON p.id = i.produto_id
     WHERE i.cliente_id = $1 AND i.ativo = TRUE AND p.ativo = TRUE ORDER BY p.id, i.id DESC`, [clienteId]
  );
  const rows = p.rows.map((x) => {
    const ef = precoEfetivo(x);
    return { id: x.id, nome: x.nome, descricao: x.descricao, saldo: x.saldo,
      preco_centavos: ef.preco_centavos, preco_original: ef.preco_original, promo: ef.promo, promo_rotulo: ef.promo_rotulo,
      preco_txt: formatBRL(ef.preco_centavos), preco_original_txt: formatBRL(ef.preco_original) };
  }).sort((a, b) => a.nome.localeCompare(b.nome));
  return anexarCores(rows);
}
async function saldosTodos() {
  const p = await db.query('SELECT id, nome, descricao, saldo, ativo FROM produtos ORDER BY nome');
  return anexarCores(p.rows);
}
async function anexarCores(produtos) {
  const ids = produtos.map((x) => x.id);
  const map = new Map();
  if (ids.length) {
    const c = await db.query('SELECT id, produto_id, nome, sku, saldo FROM produto_cores WHERE produto_id = ANY($1::int[]) ORDER BY ordem, id', [ids]);
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

module.exports = { MOTIVOS, movimentar, baixarEtiqueta, saldosParaCliente, saldosTodos, historico };
