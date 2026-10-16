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

// Admin completo ('admin') e admin operacional ('operador') entram na area administrativa.
function exigeAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (u.papel !== 'admin' && u.papel !== 'operador') return res.status(403).render('erro', { titulo: 'Acesso negado', mensagem: 'Esta area e restrita ao administrador.', user: u });
  next();
}
// So o admin completo: custos/lucros de produto, comissoes, taxas, repasses, contas de admin, exclusoes.
function exigeAdminFull(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (u.papel !== 'admin') return res.status(403).render('erro', { titulo: 'Acesso negado', mensagem: 'Esta area e restrita ao administrador completo (valores de custo, lucro e comissao).', user: u });
  next();
}
function isAdminFull(u) { return !!(u && u.papel === 'admin'); }

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

module.exports = { currentUser, exigeLogin, exigeAdmin, exigeAdminFull, isAdminFull, exigeCliente, exigeRepresentante, exigeFuncionario };
