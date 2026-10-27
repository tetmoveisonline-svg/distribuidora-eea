'use strict';
// Imagens de produto: upload (admin), listagem por produto e entrega (qualquer usuario logado).
const multer = require('multer');
const db = require('./db');

const MAX_POR_PRODUTO = 8;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: MAX_POR_PRODUTO },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});

async function listarPorProdutos(ids) {
  if (!ids.length) return new Map();
  const r = await db.query('SELECT id, produto_id, nome, tamanho FROM produto_imagens WHERE produto_id = ANY($1::int[]) ORDER BY produto_id, ordem, id', [ids]);
  const map = new Map();
  for (const x of r.rows) { if (!map.has(x.produto_id)) map.set(x.produto_id, []); map.get(x.produto_id).push({ id: x.id, nome: x.nome, tamanho: x.tamanho }); }
  return map;
}
async function anexar(produtos) {
  const map = await listarPorProdutos(produtos.map((p) => p.id));
  return produtos.map((p) => ({ ...p, imagens: map.get(p.id) || [] }));
}
async function adicionar(produtoId, files) {
  if (!files || !files.length) throw new Error('Escolha ao menos uma imagem (JPG, PNG, WEBP ou GIF até 6 MB).');
  const n = await db.query('SELECT count(*)::int AS n, COALESCE(max(ordem), -1) AS o FROM produto_imagens WHERE produto_id = $1', [produtoId]);
  if (n.rows[0].n + files.length > MAX_POR_PRODUTO) throw new Error('Máximo de ' + MAX_POR_PRODUTO + ' imagens por produto.');
  let ordem = n.rows[0].o;
  for (const f of files) {
    const nome = (f.originalname || 'imagem').replace(/[^\w.\-() ]+/g, '_').slice(0, 120);
    await db.query('INSERT INTO produto_imagens (produto_id, nome, mime, tamanho, dados, ordem) VALUES ($1,$2,$3,$4,$5,$6)', [produtoId, nome, f.mimetype, f.size, f.buffer, ++ordem]);
  }
  return (await listarPorProdutos([produtoId])).get(produtoId) || [];
}
async function remover(produtoId, imagemId) {
  await db.query('DELETE FROM produto_imagens WHERE id = $1 AND produto_id = $2', [imagemId, produtoId]);
  return (await listarPorProdutos([produtoId])).get(produtoId) || [];
}
// GET /produtos/:id/imagens/:img  (?baixar=1 forca download)
async function servir(req, res) {
  const r = await db.query('SELECT nome, mime, tamanho, dados FROM produto_imagens WHERE id = $1 AND produto_id = $2', [Number(req.params.img), Number(req.params.id)]);
  if (!r.rows.length) return res.status(404).send('Imagem não encontrada.');
  const x = r.rows[0];
  res.setHeader('Content-Type', x.mime);
  res.setHeader('Content-Length', x.tamanho);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', (req.query.baixar ? 'attachment' : 'inline') + '; filename="' + x.nome.replace(/"/g, '') + '"');
  res.send(x.dados);
}

module.exports = { upload, MAX_POR_PRODUTO, listarPorProdutos, anexar, adicionar, remover, servir };
