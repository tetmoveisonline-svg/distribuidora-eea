'use strict';

// Estacao de Bipagem por CLIENTE.
// O operador nao sabe de qual pedido e cada etiqueta: ele escolhe o cliente e bipa.
// O sistema casa o codigo lido (BR... ou chave da nota, gravados no upload) com a
// etiqueta exata, em qualquer pedido daquele cliente.
//   Separacao -> bipa; ao primeiro bipe de um pedido ele ja aparece "Em separacao".
//   Despacho  -> so aceita etiqueta ja separada; quando todas do pedido sao despachadas,
//                o pedido vira "Despachado" sozinho.
// "Finalizar" confirma o parcial e deixa o pedido aberto para o restante depois.

const express = require('express');
const db = require('../db');
const { exigeAdmin } = require('../auth');
const { formatDateTime, formatBRL } = require('../util');
const financeiro = require('../financeiro');
const estoque = require('../estoque');

const router = express.Router();
router.use(exigeAdmin);

function normCod(v) { return String(v || '').trim().toUpperCase().slice(0, 80); }
function rotuloStatus(status) {
  if (status === 'despachado') return 'Despachado';
  if (status === 'separacao' || status === 'preparando') return 'Em separação';
  return 'Aguardando separação';
}

// Monta o estado completo de um cliente: pedidos em aberto, etiquetas e contagens.
async function estadoCliente(clienteId) {
  const c = await db.query('SELECT id, nome FROM clientes WHERE id = $1', [clienteId]);
  if (c.rowCount === 0) return null;
  const r = await db.query(
    `SELECT p.id AS pedido_id, p.numero, p.status AS pstatus,
            e.id AS etq_id, e.indice, e.status AS estatus, e.codigo_externo, e.codigo_nfe, e.despachado_em, l.item_nome, l.preco_centavos
     FROM pedidos p
     JOIN etiquetas e ON e.pedido_id = p.id
     LEFT JOIN linhas l ON l.id = e.linha_id
     WHERE p.cliente_id = $1 AND p.status <> 'despachado'
     ORDER BY p.id, e.indice`, [clienteId]
  );
  const pedidosMap = new Map();
  let total = 0, separadas = 0, despachadas = 0;
  for (const row of r.rows) {
    if (!pedidosMap.has(row.pedido_id)) {
      pedidosMap.set(row.pedido_id, {
        pedido_id: row.pedido_id, numero: row.numero, status: row.pstatus,
        rotulo: rotuloStatus(row.pstatus), total: 0, separadas: 0, despachadas: 0, semcodigo: 0,
        sobras_centavos: 0, // valor das etiquetas ainda nao despachadas (vira credito se encerrar agora)
        etiquetas: [],
      });
    }
    const ped = pedidosMap.get(row.pedido_id);
    const sep = row.estatus === 'conferido' || row.estatus === 'despachado';
    const desp = row.estatus === 'despachado';
    ped.etiquetas.push({
      id: row.etq_id, indice: row.indice, item_nome: row.item_nome || '-',
      status: row.estatus, temCodigo: !!(row.codigo_externo || row.codigo_nfe),
      codigo_externo: row.codigo_externo || null, codigo_nfe: row.codigo_nfe || null,
      despachado_em: row.despachado_em ? formatDateTime(row.despachado_em) : null,
    });
    ped.total++; total++;
    if (sep) { ped.separadas++; separadas++; }
    if (desp) { ped.despachadas++; despachadas++; } else ped.sobras_centavos += Number(row.preco_centavos || 0);
    if (!row.codigo_externo) ped.semcodigo++;
  }
  return {
    clienteId: c.rows[0].id, nome: c.rows[0].nome,
    total, separadas, despachadas,
    pedidos: Array.from(pedidosMap.values()),
  };
}

// ---------- Tela ----------
router.get('/', async (req, res, next) => {
  try {
    const cl = await db.query(
      `SELECT c.id, c.nome, count(*)::int AS abertas
       FROM clientes c
       JOIN pedidos p ON p.cliente_id = c.id
       JOIN etiquetas e ON e.pedido_id = p.id
       WHERE e.status <> 'despachado' AND p.status <> 'despachado'
       GROUP BY c.id, c.nome
       HAVING count(*) > 0
       ORDER BY c.nome`
    );
    const sel = req.query.cliente ? parseInt(req.query.cliente, 10) : null;
    res.render('admin/bipagem', { ativo: 'bipagem', clientes: cl.rows, selecionado: (sel && !isNaN(sel)) ? sel : null });
  } catch (e) { next(e); }
});

// ---------- Estado de um cliente (JSON) ----------
router.get('/cliente/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'Cliente inválido.' });
    const est = await estadoCliente(id);
    if (!est) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json({ ok: true, estado: est });
  } catch (e) { console.error('Erro estado bipagem:', e); res.status(500).json({ erro: 'Falha ao carregar o cliente.' }); }
});

// Aplica a transicao de status no pedido depois de marcar uma etiqueta.
async function aposMarcar(client, pedidoId, modo) {
  if (modo === 'separacao') {
    await client.query(
      "UPDATE pedidos SET status = 'separacao', separacao_em = COALESCE(separacao_em, now()) WHERE id = $1 AND status = 'aguardando'",
      [pedidoId]
    );
  } else {
    const rest = await client.query("SELECT count(*)::int AS r FROM etiquetas WHERE pedido_id = $1 AND status <> 'despachado'", [pedidoId]);
    if (rest.rows[0].r === 0) {
      await client.query(
        "UPDATE pedidos SET status = 'despachado', despachado_em = now(), separacao_em = COALESCE(separacao_em, now()) WHERE id = $1",
        [pedidoId]
      );
    }
  }
}

// ---------- Bipar por codigo ----------
router.post('/scan', async (req, res) => {
  const body = req.body || {};
  const clienteId = parseInt(body.clienteId, 10);
  const modo = body.modo === 'despacho' ? 'despacho' : 'separacao';
  const codigo = normCod(body.codigo);
  if (!clienteId) return res.status(400).json({ erro: 'Selecione um cliente.' });
  if (!codigo) return res.status(400).json({ erro: 'Bipe um código.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // procura a etiqueta certa pelo codigo (BR... ou chave da nota), no status esperado.
    const alvo = modo === 'separacao' ? 'pendente' : 'conferido';
    const found = await client.query(
      `SELECT e.id, e.pedido_id, p.numero, l.item_nome
       FROM etiquetas e JOIN pedidos p ON p.id = e.pedido_id LEFT JOIN linhas l ON l.id = e.linha_id
       WHERE p.cliente_id = $1 AND p.status <> 'despachado' AND e.status = $2
         AND (e.codigo_externo = $3 OR e.codigo_nfe = $3)
       ORDER BY e.pedido_id, e.indice
       LIMIT 1 FOR UPDATE OF e`,
      [clienteId, alvo, codigo]
    );

    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      // diagnostico: o codigo existe para este cliente?
      const any = await db.query(
        `SELECT e.status FROM etiquetas e JOIN pedidos p ON p.id = e.pedido_id
         WHERE p.cliente_id = $1 AND (e.codigo_externo = $2 OR e.codigo_nfe = $2)
         ORDER BY (e.status='despachado') DESC LIMIT 1`, [clienteId, codigo]
      );
      let erro;
      if (any.rowCount === 0) erro = 'Etiqueta não encontrada neste cliente. Confira se é o cliente certo.';
      else if (modo === 'separacao') erro = 'Esta etiqueta já foi separada.';
      else if (any.rows[0].status === 'pendente') erro = 'Esta etiqueta ainda não passou pela separação.';
      else erro = 'Esta etiqueta já foi despachada.';
      const est = await estadoCliente(clienteId);
      return res.status(409).json({ erro, estado: est });
    }

    const et = found.rows[0];
    if (modo === 'separacao') {
      await client.query("UPDATE etiquetas SET status = 'conferido', conferido_em = now() WHERE id = $1", [et.id]);
    } else {
      await client.query("UPDATE etiquetas SET status = 'despachado', despachado_em = now() WHERE id = $1", [et.id]);
      await estoque.baixarEtiqueta(client, et.id, req.session.user.id); // baixa 1 do estoque da cor
    }
    await aposMarcar(client, et.pedido_id, modo);
    await client.query('COMMIT');
    const est = await estadoCliente(clienteId);
    const aviso = (modo === 'separacao' ? 'Separada' : 'Despachada') + ' · ' + et.numero + ' · ' + (et.item_nome || '-');
    res.json({ ok: true, aviso, estado: est });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro ao bipar:', e);
    res.status(500).json({ erro: 'Falha ao registrar a bipagem.' });
  } finally { client.release(); }
});

// ---------- Marcar manual (etiqueta sem codigo / conferir manual) ----------
router.post('/marcar', async (req, res) => {
  const body = req.body || {};
  const clienteId = parseInt(body.clienteId, 10);
  const etqId = parseInt(body.etiquetaId, 10);
  const modo = body.modo === 'despacho' ? 'despacho' : 'separacao';
  if (!clienteId || !etqId) return res.status(400).json({ erro: 'Dados inválidos.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const e = await client.query(
      `SELECT e.id, e.pedido_id, e.status FROM etiquetas e JOIN pedidos p ON p.id = e.pedido_id
       WHERE e.id = $1 AND p.cliente_id = $2 AND p.status <> 'despachado' FOR UPDATE OF e`, [etqId, clienteId]
    );
    if (e.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ erro: 'Etiqueta não encontrada.' }); }
    const st = e.rows[0].status, pedidoId = e.rows[0].pedido_id;
    if (modo === 'separacao') {
      if (st !== 'pendente') { await client.query('ROLLBACK'); return res.status(409).json({ erro: 'Esta etiqueta já foi separada.' }); }
      await client.query("UPDATE etiquetas SET status = 'conferido', conferido_em = now() WHERE id = $1", [etqId]);
    } else {
      if (st === 'pendente') { await client.query('ROLLBACK'); return res.status(409).json({ erro: 'Separe a etiqueta antes de despachar.' }); }
      if (st === 'despachado') { await client.query('ROLLBACK'); return res.status(409).json({ erro: 'Esta etiqueta já foi despachada.' }); }
      await client.query("UPDATE etiquetas SET status = 'despachado', despachado_em = now() WHERE id = $1", [etqId]);
      await estoque.baixarEtiqueta(client, etqId, req.session.user.id);
    }
    await aposMarcar(client, pedidoId, modo);
    await client.query('COMMIT');
    const est = await estadoCliente(clienteId);
    res.json({ ok: true, aviso: 'Etiqueta marcada manualmente.', estado: est });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao marcar manual:', err);
    res.status(500).json({ erro: 'Falha ao marcar a etiqueta.' });
  } finally { client.release(); }
});

// ---------- Encerrar pedido com sobras ----------
// As etiquetas nao despachadas viram "nao enviada" e saem da cobranca; o valor delas vira credito.
router.post('/encerrar', async (req, res) => {
  const clienteId = parseInt((req.body || {}).clienteId, 10);
  const pedidoId = parseInt((req.body || {}).pedidoId, 10);
  if (!clienteId || !pedidoId) return res.status(400).json({ erro: 'Dados inválidos.' });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const chk = await client.query('SELECT numero FROM pedidos WHERE id = $1 AND cliente_id = $2', [pedidoId, clienteId]);
    if (chk.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ erro: 'Pedido não encontrado para este cliente.' }); }
    const r = await financeiro.encerrarPedido(client, pedidoId);
    await client.query('COMMIT');
    const est = await estadoCliente(clienteId);
    let msg = 'Pedido ' + chk.rows[0].numero + ' encerrado: ' + r.despachadas + ' despachada(s), ' + r.naoEnviadas + ' não enviada(s). Cobrança final ' + formatBRL(r.valorCobrado) + '.';
    if (r.creditoGerado > 0) msg += r.jaPago ? ' ' + formatBRL(r.creditoGerado) + ' viraram crédito em conta do cliente.' : ' ' + formatBRL(r.creditoGerado) + ' liberados do limite.';
    res.json({ ok: true, mensagem: msg, estado: est });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro ao encerrar pedido:', e);
    res.status(400).json({ erro: e.message || 'Falha ao encerrar o pedido.' });
  } finally { client.release(); }
});

// ---------- Finalizar / atualizar para o cliente (parcial; deixa o pedido aberto) ----------
router.post('/finalizar', async (req, res) => {
  const clienteId = parseInt((req.body || {}).clienteId, 10);
  if (!clienteId) return res.status(400).json({ erro: 'Selecione um cliente.' });
  try {
    await db.query(
      `UPDATE pedidos SET status = 'separacao', separacao_em = COALESCE(separacao_em, now())
       WHERE cliente_id = $1 AND status = 'aguardando'
         AND EXISTS (SELECT 1 FROM etiquetas e WHERE e.pedido_id = pedidos.id AND e.status IN ('conferido','despachado'))`,
      [clienteId]
    );
    const est = await estadoCliente(clienteId);
    res.json({ ok: true, estado: est, mensagem: 'Status atualizado para o cliente. As etiquetas não bipadas seguem pendentes.' });
  } catch (e) { console.error('Erro ao finalizar:', e); res.status(500).json({ erro: 'Falha ao finalizar.' }); }
});

module.exports = router;
