'use strict';

// Dimensionador de bomba de calor para piscina (GN Representacoes / Syllent): pagina publica, sem login.
// Mesma tela do programa de desktop (projetos/dimensionador-piscina/src/renderer); o PDF sai pela
// impressao do navegador. Os arquivos ficam em public/dimensionador e sao copiados de la.

const path = require('path');
const express = require('express');

const router = express.Router();

router.get('/dimensionamento', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'dimensionador', 'index.html'));
});

module.exports = router;
