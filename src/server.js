'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const db = require('./db');
const { currentUser } = require('./auth');
const { ensureAdmin } = require('./bootstrap');

const app = express();
app.set('trust proxy', 1); // Railway fica atras de proxy (necessario para IP e cookies secure).
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

app.use(session({
  store: new PgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'segredo-inseguro-troque-no-env',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 12, // 12h
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

// Expoe o usuario logado para todas as views.
app.use((req, res, next) => {
  res.locals.user = currentUser(req);
  res.locals.isFull = !!(res.locals.user && res.locals.user.papel === 'admin'); // admin completo (ve custos, lucros e comissoes)
  // Radio na area do cliente (comeca pausada; o cliente da play). Vazio em RADIO_URL desliga.
  res.locals.radio = {
    nome: process.env.RADIO_NOME || '89 FM · A Rádio Rock',
    url: process.env.RADIO_URL !== undefined ? process.env.RADIO_URL : 'https://playerservices.streamtheworld.com/api/livestream-redirect/RADIO_89FM_ADP.aac?dist=site-89fm',
    site: process.env.RADIO_SITE || 'https://www.radiorock.com.br/',
  };
  res.locals.empresa = {
    nome: process.env.EMPRESA_NOME || 'A4 Móveis Distribuidora',
  };
  next();
});

// Presenca: grava o ultimo acesso do usuario logado (no maximo 1x por minuto por usuario).
const vistoCache = new Map();
app.use((req, res, next) => {
  const u = currentUser(req);
  if (u && req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/css') && !req.path.startsWith('/js') && !req.path.startsWith('/img') && !req.path.endsWith('.json')) {
    const agora = Date.now();
    const ultimo = vistoCache.get(u.id) || 0;
    if (agora - ultimo > 60000) {
      vistoCache.set(u.id, agora);
      db.query('UPDATE usuarios SET visto_em = now(), ultima_pagina = $2 WHERE id = $1', [u.id, req.path.slice(0, 80)]).catch(() => {});
    }
  }
  next();
});

// Rotas.
const authRoutes = require('./routes/auth');
app.use('/', authRoutes);
app.use('/', require('./routes/cliente'));
app.use('/admin/bipagem', require('./routes/bipagem'));
app.use('/admin', require('./routes/admin'));
app.use('/rep', require('./routes/rep'));
app.use('/func', require('./routes/func'));

// Raiz: manda pra area certa.
app.get('/', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  return res.redirect(authRoutes.homePorPapel(u.papel));
});

// 404.
app.use((req, res) => {
  res.status(404).render('erro', { titulo: 'Pagina nao encontrada', mensagem: 'O endereco acessado nao existe.', user: currentUser(req) });
});

// Erros.
app.use((err, req, res, next) => {
  console.error('Erro na aplicacao:', err);
  res.status(500).render('erro', { titulo: 'Erro interno', mensagem: 'Algo deu errado. Tente novamente.', user: currentUser(req) });
});

const PORT = process.env.PORT || 3000;

db.initSchema()
  .then(() => ensureAdmin(db))
  .then((r) => {
    if (r && r.created) console.log('Admin criado automaticamente. Login: ' + r.login);
    app.listen(PORT, () => console.log('Central de Postagem rodando na porta ' + PORT));
  })
  .catch((err) => {
    console.error('Falha ao inicializar:', err);
    process.exit(1);
  });
