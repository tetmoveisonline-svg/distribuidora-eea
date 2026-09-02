'use strict';

// Estacao de Bipagem (Operacao).
// Fluxo:
//   Separacao  -> bipa cada etiqueta; quando todas ficam 'conferido', o pedido vira status 'separacao'
//                 (o cliente passa a ver "Em separação").
//   Despacho   -> so libera depois da separacao concluida; bipa todas de novo; quando todas ficam
//                 'despachado', o pedido vira status 'despachado' automaticamente.
// Nao existe botao manual de despacho: o status muda sozinho conforme a bipagem.

const express = require('express');
const db = require('../db');
const { exigeAdmin } = require('../auth');
const { formatDateTime } = require('../util');

const router = express.Router();
router.use(exigeAdmin);

// Conta as etiquetas do pedido por situacao.
async function contarEtiquetas(pedidoId) {
  const r = await db.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'pendente')::int  AS pendentes,
       count(*) FILTER (WHERE status = 'conferido')::int AS conferidos,
       count(*) FILTER (WHERE status = 'despachado')::int AS despachados
     FROM etiquetas WHERE pedido_id = $1`, [pedidoId]
  );
  const c = r.rows[0] || { total: 0, pendentes: 0, conferidos: 0, despachados: 0 };
  // "separados" = ja passaram pela separacao (conferido ou despachado).
  c.separados = c.conferidos + c.despachados;
  return c;
}

// Estado resumido do pedido para a tela (contagens + status/rotulo).
function rotuloStatus(status) {
  if (status === 'despachado') return 'Despachado';
  if (status === 'separacao' || status === 'preparando') return 'Em separação';
  return 'Aguardando separação';
}

async function estadoPedido(pedidoId) {
  const p = await db.query(
    'SELECT id, numero, status, total_etiquetas, separacao_em, despachado_em FROM pedidos WHERE id = $1', [pedidoId]
  );
  if (p.rowCount === 0) return null;
  const ped = p.rows[0];
  const cont = await contarEtiquetas(pedidoId);
  return {
    id: ped.id, numero: ped.numero, status: ped.status, rotulo: rotuloStatus(ped.status),
    total: cont.total, pendentes: cont.pendentes, conferidos: cont.conferidos,
    despachados: cont.despachados, separados: cont.separados,
    separacaoConcluida: cont.total > 0 && cont.separados >= cont.total,
    despachoConcluido: cont.total > 0 && cont.despachados >= cont.total,
    separacaoEm: ped.separacao_em ? formatDateTime(ped.separacao_em) : null,
    despachadoEm: ped.despachado_em ? formatDateTime(ped.despachado_em) : null,
  };
}

// ---------- Tela da estacao ----------
router.get('/', async (req, res, next) => {
  try {
    // Pedidos que ainda nao foram totalmente despachados aparecem primeiro na lista.
    const r = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_etiquetas, c.nome AS cliente_nome
       FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
       WHERE p.status <> 'despachado'
       ORDER BY p.id DESC`
    );
    const selecionado = req.query.pedido ? parseInt(req.query.pedido, 10) : null;
    res.render('admin/bipagem', {
      ativo: 'bipagem',
      pedidos: r.rows,
      selecionado: (selecionado && !isNaN(selecionado)) ? selecionado : null,
    });
  } catch (e) { next(e); }
});

// ---------- Estado atual de um pedido (JSON) ----------
router.get('/pedido/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'Pedido inválido.' });
    const est = await estadoPedido(id);
    if (!est) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.json({ ok: true, estado: est });
  } catch (e) { console.error('Erro no estado da bipagem:', e); res.status(500).json({ erro: 'Falha ao carregar o pedido.' }); }
});

// ---------- Bipar (JSON) ----------
router.post('/scan', async (req, res) => {
  const body = req.body || {};
  const pedidoId = parseInt(body.pedidoId, 10);
  const modo = body.modo === 'despacho' ? 'despacho' : 'separacao';
  const codigo = (body.codigo || '').toString().trim();

  if (!pedidoId) return res.status(400).json({ erro: 'Selecione um pedido.' });
  if (!codigo) return res.status(400).json({ erro: 'Bipe um código.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const p = await client.query(
      'SELECT id, status FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]
    );
    if (p.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ erro: 'Pedido não encontrado.' }); }

    const cont = await client.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'conferido')::int  AS conferidos,
         count(*) FILTER (WHERE status = 'despachado')::int AS despachados
       FROM etiquetas WHERE pedido_id = $1`, [pedidoId]
    );
    const total = cont.rows[0].total;
    const conferidos = cont.rows[0].conferidos;
    const despachados = cont.rows[0].despachados;
    const separados = conferidos + despachados;

    if (total === 0) { await client.query('ROLLBACK'); return res.status(400).json({ erro: 'Este pedido não tem etiquetas.' }); }

    let aviso = null;

    if (modo === 'separacao') {
      if (separados >= total) {
        await client.query('ROLLBACK');
        const est = await estadoPedido(pedidoId);
        return res.json({ ok: true, jaCompleto: true, mensagem: 'Separação já concluída.', estado: est });
      }
      // Impede bipar a mesma etiqueta (mesmo codigo) duas vezes na separacao.
      const dup = await client.query(
        "SELECT 1 FROM etiquetas WHERE pedido_id = $1 AND codigo_externo = $2 AND status IN ('conferido','despachado') LIMIT 1",
        [pedidoId, codigo]
      );
      if (dup.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ erro: 'Esta etiqueta já foi bipada na separação.' });
      }
      // Marca a proxima etiqueta pendente como conferida.
      const upd = await client.query(
        `UPDATE etiquetas SET status = 'conferido', conferido_em = now(), codigo_externo = $2
         WHERE id = (SELECT id FROM etiquetas WHERE pedido_id = $1 AND status = 'pendente' ORDER BY indice LIMIT 1)
         RETURNING id`, [pedidoId, codigo]
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ erro: 'Não há etiqueta pendente para separar.' });
      }
      // Concluiu a separacao? Atualiza o pedido (se ainda nao despachado).
      if (separados + 1 >= total) {
        await client.query(
          "UPDATE pedidos SET status = 'separacao', separacao_em = COALESCE(separacao_em, now()) WHERE id = $1 AND status <> 'despachado'",
          [pedidoId]
        );
        aviso = 'Separação concluída. O cliente já vê "Em separação".';
      }
    } else {
      // Despacho: exige separacao concluida.
      if (separados < total) {
        await client.query('ROLLBACK');
        return res.status(409).json({ erro: 'Conclua a separação antes de despachar.' });
      }
      if (despachados >= total) {
        await client.query('ROLLBACK');
        const est = await estadoPedido(pedidoId);
        return res.json({ ok: true, jaCompleto: true, mensagem: 'Despacho já concluído.', estado: est });
      }
      // Ja despachada com este codigo?
      const dup = await client.query(
        "SELECT 1 FROM etiquetas WHERE pedido_id = $1 AND codigo_externo = $2 AND status = 'despachado' LIMIT 1",
        [pedidoId, codigo]
      );
      if (dup.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ erro: 'Esta etiqueta já foi despachada.' });
      }
      // Preferencial: casar com a etiqueta separada de mesmo codigo.
      let upd = await client.query(
        `UPDATE etiquetas SET status = 'despachado', despachado_em = now()
         WHERE id = (SELECT id FROM etiquetas WHERE pedido_id = $1 AND status = 'conferido' AND codigo_externo = $2 ORDER BY indice LIMIT 1)
         RETURNING id`, [pedidoId, codigo]
      );
      // Fallback (pedidos separados antes deste recurso, sem codigo gravado).
      if (upd.rowCount === 0) {
        upd = await client.query(
          `UPDATE etiquetas SET status = 'despachado', despachado_em = now(), codigo_externo = COALESCE(codigo_externo, $2)
           WHERE id = (SELECT id FROM etiquetas WHERE pedido_id = $1 AND status = 'conferido' AND codigo_externo IS NULL ORDER BY indice LIMIT 1)
           RETURNING id`, [pedidoId, codigo]
        );
      }
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ erro: 'Código não confere com as etiquetas separadas deste pedido.' });
      }
      if (despachados + 1 >= total) {
        await client.query(
          "UPDATE pedidos SET status = 'despachado', despachado_em = now(), separacao_em = COALESCE(separacao_em, now()) WHERE id = $1",
          [pedidoId]
        );
        aviso = 'Despacho concluído. Pedido marcado como despachado.';
      }
    }

    await client.query('COMMIT');
    const est = await estadoPedido(pedidoId);
    res.json({ ok: true, aviso, estado: est });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro ao bipar:', e);
    res.status(500).json({ erro: 'Falha ao registrar a bipagem.' });
  } finally { client.release(); }
});

module.exports = router;
