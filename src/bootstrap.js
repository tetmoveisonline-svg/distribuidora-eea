'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Garante que exista um admin. Se nenhum admin existir, cria a partir das
// variaveis de ambiente (ADMIN_NOME / ADMIN_LOGIN / ADMIN_SENHA).
// Sem ADMIN_SENHA, gera uma senha aleatoria e a mostra UMA vez no log (nunca usa
// uma senha padrao publica). Roda automaticamente no boot.
async function ensureAdmin(db) {
  const login = process.env.ADMIN_LOGIN || 'admin';
  const existe = await db.query("SELECT id FROM usuarios WHERE papel = 'admin' LIMIT 1");
  if (existe.rowCount > 0) return { created: false };

  const nome = process.env.ADMIN_NOME || 'Administrador';
  let senha = process.env.ADMIN_SENHA;
  let gerada = false;
  if (!senha) {
    // senha forte aleatoria (sem caracteres ambiguos), exibida uma vez no log
    senha = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
    gerada = true;
  }
  const hash = await bcrypt.hash(senha, 10);
  await db.query(
    'INSERT INTO usuarios (nome, login, senha_hash, papel) VALUES ($1,$2,$3,$4)',
    [nome, login, hash, 'admin']
  );
  if (gerada) {
    console.warn('==============================================================');
    console.warn('ADMIN criado. Login: ' + login + '  Senha (gerada, troque depois): ' + senha);
    console.warn('Defina ADMIN_SENHA no ambiente para controlar a senha inicial.');
    console.warn('==============================================================');
  }
  return { created: true, login, senhaGerada: gerada };
}

module.exports = { ensureAdmin };
