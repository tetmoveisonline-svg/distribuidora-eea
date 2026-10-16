'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { currentUser } = require('../auth');

const router = express.Router();

function homePorPapel(papel) {
  if (papel === 'admin' || papel === 'operador') return '/admin/pedidos';
  if (papel === 'representante') return '/rep/pedidos';
  if (papel === 'funcionario') return '/func/pedidos';
  return '/inicio';
}
router.homePorPapel = homePorPapel;

router.get('/login', (req, res) => {
  if (currentUser(req)) {
    return res.redirect(homePorPapel(currentUser(req).papel));
  }
  res.render('login', { erro: null });
});

router.post('/login', async (req, res, next) => {
  try {
    const login = (req.body.login || '').trim();
    const senha = req.body.senha || '';
    if (!login || !senha) {
      return res.status(400).render('login', { erro: 'Informe usuario e senha.' });
    }

    const r = await db.query('SELECT * FROM usuarios WHERE login = $1 AND ativo = TRUE', [login]);
    if (r.rowCount === 0) {
      return res.status(401).render('login', { erro: 'Usuario ou senha invalidos.' });
    }
    const usuario = r.rows[0];
    const ok = await bcrypt.compare(senha, usuario.senha_hash);
    if (!ok) {
      return res.status(401).render('login', { erro: 'Usuario ou senha invalidos.' });
    }

    req.session.user = {
      id: usuario.id,
      nome: usuario.nome,
      login: usuario.login,
      papel: usuario.papel,
      clienteId: usuario.cliente_id,
    };
    return res.redirect(homePorPapel(usuario.papel));
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
