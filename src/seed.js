'use strict';

// Uso opcional (linha de comando). No Railway NAO e necessario: o admin e criado
// automaticamente no primeiro boot (ver src/bootstrap.js).
//
//   npm run seed            -> garante o admin
//   npm run seed -- --demo  -> cria tambem um cliente demo com itens (login: cliente / senha: cliente123)

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');
const { ensureAdmin } = require('./bootstrap');

async function main() {
  await db.initSchema();

  const r = await ensureAdmin(db);
  console.log(r.created ? ('Admin criado. Login: ' + r.login) : 'Admin ja existe. Nada a fazer.');

  if (process.argv.includes('--demo')) {
    await seedDemo();
  }

  await db.pool.end();
  console.log('Seed concluido.');
}

async function seedDemo() {
  const jaTem = await db.query('SELECT id FROM clientes WHERE nome = $1', ['Loja do Cliente Ltda']);
  if (jaTem.rowCount > 0) {
    console.log('Cliente demo ja existe. Nada a fazer.');
    return;
  }
  const c = await db.query(
    'INSERT INTO clientes (nome, email) VALUES ($1,$2) RETURNING id',
    ['Loja do Cliente Ltda', 'cliente@email.com']
  );
  const clienteId = c.rows[0].id;

  const hash = await bcrypt.hash('cliente123', 10);
  await db.query(
    'INSERT INTO usuarios (nome, login, senha_hash, papel, cliente_id) VALUES ($1,$2,$3,$4,$5)',
    ['Loja do Cliente Ltda', 'cliente', hash, 'cliente', clienteId]
  );

  const itens = [['PAC ate 300g', 450], ['SEDEX ate 300g', 980], ['PAC 301g a 1kg', 620]];
  for (const [n, p] of itens) {
    await db.query('INSERT INTO itens (cliente_id, nome, preco_centavos) VALUES ($1,$2,$3)', [clienteId, n, p]);
  }
  console.log('Cliente demo criado. Login: cliente  Senha: cliente123');
}

main().catch((err) => { console.error('Falha no seed:', err); process.exit(1); });
