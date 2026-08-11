'use strict';

// Middlewares de autenticacao/autorizacao baseados na sessao.

function currentUser(req) {
  return (req.session && req.session.user) ? req.session.user : null;
}

function exigeLogin(req, res, next) {
  if (!currentUser(req)) {
    return res.redirect('/login');
  }
  next();
}

function exigeAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (u.papel !== 'admin') return res.status(403).render('erro', { titulo: 'Acesso negado', mensagem: 'Esta area e restrita ao administrador.', user: u });
  next();
}

function exigeCliente(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (u.papel !== 'cliente') return res.status(403).render('erro', { titulo: 'Acesso negado', mensagem: 'Esta area e do cliente.', user: u });
  next();
}

module.exports = { currentUser, exigeLogin, exigeAdmin, exigeCliente };
