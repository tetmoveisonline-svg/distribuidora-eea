// Leitor de etiquetas: lê o código de rastreio (BR...) e a chave da nota (44 dígitos)
// de cada página do PDF, direto no navegador. Usa pdf.js (renderiza) + zbar-wasm (lê o
// código de barras/QR). Não manda nada novo pro servidor além dos códigos lidos.
//
// Exposto como window.LeitorEtiquetas.lerArquivo(file, onProgress) -> Promise<[{br,nfe}, ...]>
// (um item por página; br/nfe podem ser null quando a página não pôde ser lida).

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs';
import { scanImageData } from 'https://cdn.jsdelivr.net/npm/@undecaf/zbar-wasm@0.11.0/dist/inlined/index.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';

var RE_NFE = /^\d{44}$/;                 // chave da NF-e (44 digitos)
var RE_RASTREIO = /^[A-Z0-9]{8,}$/;      // codigo de rastreio (ex.: BR2604793934394)

function normaliza(c) { return String(c || '').trim().toUpperCase(); }

async function lerPagina(page, alvoLargura) {
  var vp = page.getViewport({ scale: 1 });
  var scale = Math.min(6, Math.max(2, (alvoLargura || 1300) / vp.width));
  vp = page.getViewport({ scale: scale });
  var canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  var syms = [];
  try { syms = await scanImageData(img); } catch (e) { syms = []; }
  var codes = [];
  for (var i = 0; i < syms.length; i++) {
    var d = '';
    try { d = syms[i].decode(); } catch (e) { d = ''; }
    d = normaliza(d);
    if (d && codes.indexOf(d) === -1) codes.push(d);
  }
  // libera memoria do canvas
  canvas.width = canvas.height = 0;
  var nfe = null, br = null;
  for (var j = 0; j < codes.length; j++) {
    if (!nfe && RE_NFE.test(codes[j])) { nfe = codes[j]; continue; }
    if (!br && !RE_NFE.test(codes[j]) && RE_RASTREIO.test(codes[j])) { br = codes[j]; }
  }
  return { br: br, nfe: nfe };
}

async function lerArquivo(file, onProgress) {
  var buf = await file.arrayBuffer();
  var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  var paginas = [];
  for (var n = 1; n <= pdf.numPages; n++) {
    var page = await pdf.getPage(n);
    var r;
    try { r = await lerPagina(page, 1300); } catch (e) { r = { br: null, nfe: null }; }
    paginas.push(r);
    if (page.cleanup) { try { page.cleanup(); } catch (e) {} }
    if (typeof onProgress === 'function') onProgress(n, pdf.numPages);
  }
  try { await pdf.destroy(); } catch (e) {}
  return paginas;
}

window.LeitorEtiquetas = { lerArquivo: lerArquivo, pronto: true };
try { window.dispatchEvent(new Event('leitor-etiquetas-pronto')); } catch (e) {}
