'use strict';

const { PDFDocument } = require('pdf-lib');

// Conta as paginas de um PDF (Buffer). Retorna 0 se nao conseguir ler.
async function contarPaginas(buffer) {
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return pdf.getPageCount();
}

// Junta varios PDFs (buffers) em um so, preservando o tamanho de cada pagina
// (1 etiqueta por pagina, formato termico original - NUNCA junta em A4).
async function juntarEtiquetas(buffers) {
  const saida = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const indices = src.getPageIndices();
    const paginas = await saida.copyPages(src, indices);
    paginas.forEach((p) => saida.addPage(p));
  }
  const bytes = await saida.save();
  return Buffer.from(bytes);
}

module.exports = { contarPaginas, juntarEtiquetas };
