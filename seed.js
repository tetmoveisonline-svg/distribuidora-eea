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

  // Produtos no catalogo (preco padrao + cores/estoque).
  const prods = [
    { nome: 'Penteadeira Dulce', desc: 'Penteadeira com espelho e gavetas', preco: 25000, cores: [['Branco', 12], ['Preto', 5]] },
    { nome: 'Comoda Lara', desc: 'Comoda 4 gavetas', preco: 18000, cores: [['Branco', 6], ['Cinza', 3]] },
  ];
  const prodInfo = {};
  for (const p of prods) {
    const pr = await db.query('INSERT INTO produtos (nome, descricao, preco_padrao_centavos) VALUES ($1,$2,$3) RETURNING id', [p.nome, p.desc, p.preco]);
    prodInfo[p.nome] = { id: pr.rows[0].id, preco: p.preco };
    for (const [cor, est] of p.cores) {
      await db.query('INSERT INTO produto_cores (produto_id, nome, estoque) VALUES ($1,$2,$3)', [pr.rows[0].id, cor, est]);
    }
  }

  // Cliente + login, com desconto padrao de 10% em cada item.
  const c = await db.query(
    'INSERT INTO clientes (nome, email, desconto_tipo, desconto_escopo, desconto_valor) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    ['Loja do Cliente Ltda', 'cliente@email.com', 'pct', 'item', 1000]
  );
  const clienteId = c.rows[0].id;
  await db.query(
    'INSERT INTO usuarios (nome, login, senha_hash, papel, cliente_id) VALUES ($1,$2,$3,$4,$5)',
    ['Loja do Cliente Ltda', 'cliente', await bcrypt.hash('cliente123', 10), 'cliente', clienteId]
  );

  // Produtos liberados para o cliente (itens), com o preco padrao.
  for (const nome of Object.keys(prodInfo)) {
    await db.query('INSERT INTO itens (cliente_id, produto_id, nome, preco_centavos) VALUES ($1,$2,$3,$4)',
      [clienteId, prodInfo[nome].id, nome, prodInfo[nome].preco]);
  }

  // Representante e funcionario demo.
  await db.query(
    'INSERT INTO usuarios (nome, login, senha_hash, papel, comissao_bps) VALUES ($1,$2,$3,$4,$5)',
    ['Carlos Souza', 'representante', await bcrypt.hash('rep123', 10), 'representante', 500]
  );
  await db.query(
    'INSERT INTO usuarios (nome, login, senha_hash, papel, taxa_etiqueta_centavos) VALUES ($1,$2,$3,$4,$5)',
    ['Joao Pereira', 'funcionario', await bcrypt.hash('func123', 10), 'funcionario', 10]
  );

  console.log('Demo criada:');
  console.log('  Cliente       -> login: cliente        senha: cliente123');
  console.log('  Representante -> login: representante   senha: rep123');
  console.log('  Funcionario   -> login: funcionario     senha: func123');
}

main().catch((err) => { console.error('Falha no seed:', err); process.exit(1); });
