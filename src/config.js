'use strict';

// Configuracoes gerais do sistema (chave/valor). Hoje guarda a taxa do imposto da nota fiscal.
const db = require('./db');

async function getValor(q, chave, def) {
  const r = await (q || db).query('SELECT valor FROM config WHERE chave = $1', [chave]);
  return r.rowCount ? r.rows[0].valor : def;
}

// Taxa do imposto da NF em pontos-base (1000 = 10%). Definida pelo admin, vale para todos os produtos.
async function nfBps(q) {
  const v = await getValor(q, 'nf_bps', '0');
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 0) return 0;
  return Math.min(100000, n); // teto de seguranca
}

async function setNfBps(q, bps) {
  await (q || db).query(
    "INSERT INTO config (chave, valor) VALUES ('nf_bps', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor",
    [String(bps)]
  );
}

module.exports = { getValor, nfBps, setNfBps };
