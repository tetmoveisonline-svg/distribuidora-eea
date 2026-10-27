'use strict';

// Precos: o preco padrao de todo produto e o sugerido (custo + taxa do funcionario + lucro) / (1 - % rep).
// "Precos por cliente" guarda apenas negociacoes (itens.negociado = TRUE), que substituem o padrao.

const db = require('./db');
const { precoSugerido, precoEfetivo, skuCor, hojeISO } = require('./util');

// Representantes e funcionarios ativos (taxas lidas do cadastro na hora).
async function refCustos() {
  const reps = await db.query("SELECT id, nome, COALESCE(comissao_bps, 0)::int AS bps FROM usuarios WHERE papel = 'representante' AND ativo = TRUE ORDER BY nome");
  const funcs = await db.query("SELECT id, nome, COALESCE(taxa_etiqueta_centavos, 0)::int AS taxa FROM usuarios WHERE papel = 'funcionario' AND ativo = TRUE ORDER BY nome");
  return { reps: reps.rows, funcs: funcs.rows };
}
// Anexa ao produto quem recebe, as taxas e o preco sugerido.
function comCustos(p, ref) {
  const rep = ref.reps.find((r) => r.id === p.rep_usuario_id) || null;
  const func = ref.funcs.find((f) => f.id === p.func_usuario_id) || null;
  const repBps = rep ? rep.bps : 0;
  const funcCentavos = func ? func.taxa : 0;
  const sugerido = precoSugerido({ custo_centavos: p.custo_centavos, lucro_centavos: p.lucro_centavos, rep_bps: repBps }, funcCentavos);
  return { ...p, rep, func, rep_bps_efetivo: repBps, func_centavos: funcCentavos, sugerido, temCustos: p.custo_centavos !== null || p.lucro_centavos !== null };
}

// Catalogo de um cliente: todos os produtos ativos, com preco negociado (se houver) ou sugerido,
// cores com SKU e estoque disponivel. Produto sem negociacao e sem sugerido fica fora (sem preco).
// q: db ou client de transacao.
async function catalogoDoCliente(q, clienteId) {
  const ref = await refCustos();
  const prods = await q.query(
    `SELECT p.id AS produto_id, p.nome, p.descricao, p.peso_gramas, p.medidas, p.custo_centavos, p.lucro_centavos, p.rep_usuario_id, p.func_usuario_id,
            p.saldo, p.reservado,
            i.id AS item_id, i.negociado, i.preco_centavos, i.promo_tipo, i.promo_valor,
            to_char(i.promo_inicio, 'YYYY-MM-DD') AS promo_inicio, to_char(i.promo_fim, 'YYYY-MM-DD') AS promo_fim
     FROM produtos p
     LEFT JOIN itens i ON i.produto_id = p.id AND i.cliente_id = $1 AND i.ativo = TRUE
     WHERE p.ativo = TRUE ORDER BY p.nome`, [clienteId]
  );
  const pids = prods.rows.map((x) => x.produto_id);
  const coresMap = new Map();
  if (pids.length) {
    const c = await q.query('SELECT id, produto_id, nome, sku, saldo, reservado FROM produto_cores WHERE produto_id = ANY($1::int[]) ORDER BY ordem, id', [pids]);
    for (const row of c.rows) { if (!coresMap.has(row.produto_id)) coresMap.set(row.produto_id, []); coresMap.get(row.produto_id).push(row); }
  }
  const hoje = hojeISO();
  const out = [];
  for (const x of prods.rows) {
    const pc = comCustos(x, ref);
    let preco, original, promo = false, promoRotulo = '', origem;
    if (x.item_id && x.negociado) {
      const ef = precoEfetivo(x, hoje);
      preco = ef.preco_centavos; original = ef.preco_original; promo = ef.promo; promoRotulo = ef.promo_rotulo; origem = 'negociado';
    } else if (pc.sugerido !== null) {
      preco = pc.sugerido; original = pc.sugerido; origem = 'sugerido';
    } else {
      continue; // sem preco: nao oferece
    }
    const cores = (coresMap.get(x.produto_id) || []).map((c) => ({ id: c.id, nome: c.nome, sku: skuCor(null, c), saldo: Number(c.saldo) - Number(c.reservado), fisico: Number(c.saldo), reservado: Number(c.reservado) }));
    out.push({
      // id do item: o da negociacao/vinculo existente, ou "p<produto>" (vinculo criado no aceite)
      id: x.item_id ? x.item_id : 'p' + x.produto_id,
      produto_id: x.produto_id, nome: x.nome, descricao: x.descricao,
      obs: [x.peso_gramas !== null && x.peso_gramas !== undefined ? (Number(x.peso_gramas) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' kg' : '', x.medidas || ''].filter(Boolean).join(' · '),
      preco_centavos: preco, preco_original: original, promo, promo_rotulo: promoRotulo, origem,
      cores, saldo: Number(x.saldo) - Number(x.reservado), fisico: Number(x.saldo), reservado: Number(x.reservado),
    });
  }
  return out;
}

// Garante o vinculo itens (cliente, produto) para gravar a linha do pedido; cria sem negociacao se faltar.
async function garantirItem(client, clienteId, item) {
  if (typeof item.id === 'number') return item.id;
  const ex = await client.query('SELECT id FROM itens WHERE cliente_id = $1 AND produto_id = $2 ORDER BY ativo DESC, id DESC LIMIT 1', [clienteId, item.produto_id]);
  if (ex.rowCount) {
    await client.query('UPDATE itens SET ativo = TRUE WHERE id = $1', [ex.rows[0].id]);
    return ex.rows[0].id;
  }
  const ins = await client.query('INSERT INTO itens (cliente_id, produto_id, nome, preco_centavos, negociado) VALUES ($1,$2,$3,$4,FALSE) RETURNING id', [clienteId, item.produto_id, item.nome, item.preco_centavos]);
  return ins.rows[0].id;
}

module.exports = { refCustos, comCustos, catalogoDoCliente, garantirItem };
