'use strict';

// Dimensionador de bomba de calor para piscina: pagina publica, sem login.
// O calculo roda no navegador; o servidor so entrega a configuracao (fatores, catalogo, clima).

const express = require('express');
const config = require('../dimensionamento-config');

const router = express.Router();

router.get('/dimensionamento', (req, res) => {
  res.render('dimensionamento', {
    titulo: 'Dimensionador de bomba de calor · ' + config.marca.nome,
    marca: config.marca,
    configJson: JSON.stringify(config).replace(/</g, '\\u003c'),
  });
});

module.exports = router;
