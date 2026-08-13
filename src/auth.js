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

function exigePapel(papel, texto) {
  return function (req, res, next) {
    const u = currentUser(req);
    if (!u) return res.redirect('/login');
    if (u.papel !== papel) return res.status(403).render('erro', { titulo: 'Acesso negado', mensagem: texto, user: u });
    next();
  };
}

const exigeRepresentante = exigePapel('representante', 'Esta area e do representante.');
const exigeFuncionario = exigePapel('funcionario', 'Esta area e do funcionario.');

module.exports = { currentUser, exigeLogin, exigeAdmin, exigeCliente, exigeRepresentante, exigeFuncionario };
