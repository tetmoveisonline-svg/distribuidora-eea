'use strict';

const bcrypt = require('bcryptjs');

// Garante que exista um admin. Se nenhum admin existir, cria a partir das
// variaveis de ambiente (ADMIN_NOME / ADMIN_LOGIN / ADMIN_SENHA).
// Roda automaticamente no boot, entao nao e preciso comando manual no Railway.
async function ensureAdmin(db) {
  const login = process.env.ADMIN_LOGIN || 'admin';
  const existe = await db.query("SELECT id FROM usuarios WHERE papel = 'admin' LIMIT 1");
  if (existe.rowCount > 0) return { created: false };

  const nome = process.env.ADMIN_NOME || 'Administrador';
  const senha = process.env.ADMIN_SENHA || 'admin123';
  const hash = await bcrypt.hash(senha, 10);
  await db.query(
    'INSERT INTO usuarios (nome, login, senha_hash, papel) VALUES ($1,$2,$3,$4)',
    [nome, login, hash, 'admin']
  );
  return { created: true, login };
}

module.exports = { ensureAdmin };
