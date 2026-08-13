'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL nao definida. Configure a variavel de ambiente (ver .env.example).');
}

// SSL: em producao/Railway o Postgres normalmente exige SSL.
// Em localhost, desliga.
function sslConfig() {
  if (process.env.PGSSL === 'false') return false;
  if (!connectionString) return false;
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);
  if (isLocal && process.env.PGSSL !== 'true') return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  ssl: sslConfig(),
  max: 10,
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do Postgres:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

// Cria/atualiza o esquema (idempotente).
async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, query, getClient, initSchema };
