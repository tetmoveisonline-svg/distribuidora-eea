'use strict';

// Feed de novidades do cliente. registrar() grava um evento; listarParaCliente() devolve os
// eventos globais (so de produtos que o cliente ve) e os do proprio cliente, mais recentes primeiro.

const db = require('./db');
const { formatDateTime, hojeISO } = require('./util');

async function registrar(q, ev) {
  try {
    await (q || db).query(
      'INSERT INTO novidades (tipo, cliente_id, produto_id, pedido_id, titulo, detalhe) VALUES ($1,$2,$3,$4,$5,$6)',
      [ev.tipo, ev.clienteId || null, ev.produtoId || null, ev.pedidoId || null, String(ev.titulo).slice(0, 160), ev.detalhe ? String(ev.detalhe).slice(0, 300) : null]
    );
  } catch (e) { console.error('novidade nao registrada:', e.message); }
}

// Evita duplicar o mesmo evento em sequencia (ex.: reposto duas vezes no mesmo dia).
async function registrarUnico(q, ev, janelaMin) {
  const r = await (q || db).query(
    `SELECT 1 FROM novidades WHERE tipo = $1 AND COALESCE(produto_id, 0) = COALESCE($2, 0) AND COALESCE(cliente_id, 0) = COALESCE($3, 0)
       AND titulo = $4 AND criado_em > now() - ($5 || ' minutes')::interval LIMIT 1`,
    [ev.tipo, ev.produtoId || null, ev.clienteId || null, String(ev.titulo).slice(0, 160), String(janelaMin || 60)]
  );
  if (r.rowCount === 0) await registrar(q, ev);
}

const ROTULO = { produto: 'Produto novo', cor: 'Cor nova', reposto: 'Estoque reposto', esgotou: 'Esgotou', promo: 'Promoção', negociado: 'Preço negociado', pedido: 'Pedido', financeiro: 'Financeiro' };

function quando(d, hoje) {
  const s = formatDateTime(d);                      // dd/mm/aaaa hh:mm
  const dia = s.slice(6, 10) + '-' + s.slice(3, 5) + '-' + s.slice(0, 2);
  if (dia === hoje) return 'hoje ' + s.slice(12);
  const ontem = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (dia === ontem) return 'ontem ' + s.slice(12);
  return s.slice(0, 5) + ' ' + s.slice(12);
}

async function listarParaCliente(clienteId, produtosVisiveis, limite) {
  const r = await db.query(
    `SELECT n.*, p.nome AS produto_nome, pe.numero AS pedido_numero
     FROM novidades n LEFT JOIN produtos p ON p.id = n.produto_id LEFT JOIN pedidos pe ON pe.id = n.pedido_id
     WHERE (n.cliente_id IS NULL OR n.cliente_id = $1) AND n.criado_em > now() - interval '45 days'
     ORDER BY n.criado_em DESC LIMIT 200`, [clienteId]
  );
  const vis = new Set(produtosVisiveis || []);
  const hoje = hojeISO();
  const out = [];
  for (const n of r.rows) {
    if (n.cliente_id === null && n.produto_id && !vis.has(n.produto_id)) continue; // produto que o cliente nao ve
    out.push({ id: n.id, tipo: n.tipo, rotulo: ROTULO[n.tipo] || n.tipo, titulo: n.titulo, detalhe: n.detalhe, produto_id: n.produto_id, pedido_id: n.pedido_id, pedido_numero: n.pedido_numero, quando: quando(n.criado_em, hoje), hoje: formatDateTime(n.criado_em).slice(6, 10) + '-' + formatDateTime(n.criado_em).slice(3, 5) + '-' + formatDateTime(n.criado_em).slice(0, 2) === hoje });
    if (out.length >= (limite || 30)) break;
  }
  return out;
}

module.exports = { registrar, registrarUnico, listarParaCliente, ROTULO };
