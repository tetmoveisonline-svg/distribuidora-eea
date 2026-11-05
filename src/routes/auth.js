'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { currentUser } = require('../auth');

const router = express.Router();

// ---------- Protecao contra forca bruta no login ----------
// Limite por IP e por conta, com janela deslizante e bloqueio temporario.
// Em memoria (suficiente para 1 instancia); zera a cada deploy/restart.
const JANELA_MS = 15 * 60 * 1000;   // janela de contagem
const BLOQUEIO_MS = 15 * 60 * 1000; // tempo de bloqueio ao estourar
const MAX_IP = 20;                  // falhas por IP na janela
const MAX_CONTA = 8;                // falhas por conta na janela
const tentativas = new Map();       // chave -> { count, first, until }

function reg(map, chave, limite) {
  const agora = Date.now();
  let e = map.get(chave);
  if (!e || agora - e.first > JANELA_MS) e = { count: 0, first: agora, until: 0 };
  e.count += 1;
  if (e.count >= limite) e.until = agora + BLOQUEIO_MS;
  map.set(chave, e);
}
function bloqueado(chave) {
  const e = tentativas.get(chave);
  if (e && e.until && e.until > Date.now()) return Math.ceil((e.until - Date.now()) / 1000);
  return 0;
}
function registraFalha(ip, login) {
  reg(tentativas, 'ip|' + ip, MAX_IP);
  reg(tentativas, 'conta|' + login, MAX_CONTA);
}
function limpaSucesso(ip, login) {
  tentativas.delete('ip|' + ip);
  tentativas.delete('conta|' + login);
}
// Limpeza periodica das entradas vencidas (nao segura o processo vivo).
setInterval(() => {
  const agora = Date.now();
  for (const [k, e] of tentativas) {
    if ((!e.until || e.until < agora) && agora - e.first > JANELA_MS) tentativas.delete(k);
  }
}, 10 * 60 * 1000).unref();

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
    const ip = req.ip || '';
    if (!login || !senha) {
      return res.status(400).render('login', { erro: 'Informe usuario e senha.' });
    }

    // Bloqueio por excesso de tentativas (IP ou conta).
    const espera = bloqueado('ip|' + ip) || bloqueado('conta|' + login);
    if (espera) {
      const min = Math.max(1, Math.ceil(espera / 60));
      return res.status(429).render('login', { erro: 'Muitas tentativas. Tente de novo em cerca de ' + min + ' min.' });
    }

    const r = await db.query('SELECT * FROM usuarios WHERE login = $1 AND ativo = TRUE', [login]);
    if (r.rowCount === 0) {
      registraFalha(ip, login);
      return res.status(401).render('login', { erro: 'Usuario ou senha invalidos.' });
    }
    const usuario = r.rows[0];
    const ok = await bcrypt.compare(senha, usuario.senha_hash);
    if (!ok) {
      registraFalha(ip, login);
      return res.status(401).render('login', { erro: 'Usuario ou senha invalidos.' });
    }

    limpaSucesso(ip, login);
    // Regenera a sessao no login para evitar fixacao de sessao.
    req.session.regenerate((errReg) => {
      if (errReg) return next(errReg);
      req.session.user = {
        id: usuario.id,
        nome: usuario.nome,
        login: usuario.login,
        papel: usuario.papel,
        clienteId: usuario.cliente_id,
      };
      req.session.save((errSave) => {
        if (errSave) return next(errSave);
        res.redirect(homePorPapel(usuario.papel));
      });
    });
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
