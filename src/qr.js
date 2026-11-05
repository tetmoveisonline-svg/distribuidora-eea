'use strict';

// Gerador de QR Code (modo byte, correcao de erro nivel M), sem dependencias.
// Segue a especificacao ISO/IEC 18004: escolhe a menor versao que cabe, monta os
// blocos com Reed-Solomon, desenha os padroes fixos e escolhe a melhor mascara.
// Uso: qrSvg('texto', { modulo: 6, margem: 4 }) -> string <svg>.

// Tabelas para o nivel M (indice = versao 1..40).
const ECC_POR_BLOCO = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const NUM_BLOCOS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMATO_M = 0; // bits do nivel M no campo de formato

function modulosBrutos(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
function codewordsDados(ver) { return Math.floor(modulosBrutos(ver) / 8) - ECC_POR_BLOCO[ver] * NUM_BLOCOS[ver]; }

// ---- Reed-Solomon em GF(256), polinomio 0x11D ----
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(grau) {
  const r = new Array(grau).fill(0);
  r[grau - 1] = 1;
  let raiz = 1;
  for (let i = 0; i < grau; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], raiz);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    raiz = gfMul(raiz, 0x02);
  }
  return r;
}
function rsResto(dados, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of dados) {
    const fator = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < divisor.length; i++) r[i] ^= gfMul(divisor[i], fator);
  }
  return r;
}

function posicoesAlinhamento(ver, tam) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const passo = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let p = tam - 7; r.length < n; p -= passo) r.splice(1, 0, p);
  return r;
}

function gerarMatriz(bytes) {
  // 1. versao
  let ver = 1;
  for (; ver <= 40; ver++) {
    const cc = ver <= 9 ? 8 : 16;
    if (4 + cc + bytes.length * 8 <= codewordsDados(ver) * 8) break;
  }
  if (ver > 40) throw new Error('Texto grande demais para QR Code.');
  const cap = codewordsDados(ver) * 8;
  // 2. bits: modo byte (0100), contagem, dados, terminador e enchimento
  const bits = [];
  const add = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  add(4, 4); add(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) add(b, 8);
  add(0, Math.min(4, cap - bits.length));
  add(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) add(pad, 8);
  const dados = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; dados.push(v); }
  // 3. blocos + ECC, intercalados
  const nBlocos = NUM_BLOCOS[ver], eccLen = ECC_POR_BLOCO[ver];
  const brutos = Math.floor(modulosBrutos(ver) / 8);
  const nCurtos = nBlocos - (brutos % nBlocos);
  const tamCurto = Math.floor(brutos / nBlocos);
  const div = rsDivisor(eccLen);
  const blocos = [];
  for (let i = 0, k = 0; i < nBlocos; i++) {
    const d = dados.slice(k, k + tamCurto - eccLen + (i < nCurtos ? 0 : 1));
    k += d.length;
    const ecc = rsResto(d, div);
    if (i < nCurtos) d.push(0);
    blocos.push(d.concat(ecc));
  }
  const final = [];
  for (let i = 0; i < blocos[0].length; i++) {
    for (let j = 0; j < blocos.length; j++) {
      if (i !== tamCurto - eccLen || j >= nCurtos) final.push(blocos[j][i]);
    }
  }
  // 4. matriz e padroes fixos
  const tam = ver * 4 + 17;
  const mod = Array.from({ length: tam }, () => new Array(tam).fill(false));
  const fixo = Array.from({ length: tam }, () => new Array(tam).fill(false));
  const set = (x, y, v) => { mod[y][x] = v; fixo[y][x] = true; };
  for (let i = 0; i < tam; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < tam && yy >= 0 && yy < tam) set(xx, yy, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(tam - 4, 3); finder(3, tam - 4);
  const al = posicoesAlinhamento(ver, tam), na = al.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const formato = (mask) => {
    const d = (FORMATO_M << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const bit = (i) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(tam - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, tam - 15 + i, bit(i));
    set(8, tam - 8, true);
  };
  formato(0); // reserva a area
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const v = ((b >>> i) & 1) !== 0, a = tam - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, v); set(c, a, v);
    }
  }
  // 5. dados em zigue-zague
  let i = 0;
  for (let dir = tam - 1; dir >= 1; dir -= 2) {
    if (dir === 6) dir = 5;
    for (let v = 0; v < tam; v++) for (let j = 0; j < 2; j++) {
      const x = dir - j, sobe = ((dir + 1) & 2) === 0, y = sobe ? tam - 1 - v : v;
      if (!fixo[y][x] && i < final.length * 8) { mod[y][x] = ((final[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
  // 6. mascara: testa as 8 e fica com a de menor penalidade
  const inverte = (m, x, y) => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const aplica = (m) => { for (let y = 0; y < tam; y++) for (let x = 0; x < tam; x++) if (!fixo[y][x] && inverte(m, x, y)) mod[y][x] = !mod[y][x]; };
  let melhor = 0, menor = Infinity;
  for (let m = 0; m < 8; m++) {
    aplica(m); formato(m);
    const p = penalidade(mod, tam);
    if (p < menor) { menor = p; melhor = m; }
    aplica(m);
  }
  aplica(melhor); formato(melhor);
  return mod;
}

function penalidade(mod, tam) {
  let p = 0;
  const linha = (get) => {
    for (let a = 0; a < tam; a++) {
      let run = 1;
      for (let b = 1; b < tam; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
      for (let b = 0; b + 10 < tam; b++) {
        const s = [];
        for (let k = 0; k < 11; k++) s.push(get(a, b + k) ? 1 : 0);
        const t = s.join('');
        if (t === '10111010000' || t === '00001011101') p += 40;
      }
    }
  };
  linha((a, b) => mod[a][b]);
  linha((a, b) => mod[b][a]);
  let escuros = 0;
  for (let y = 0; y < tam; y++) for (let x = 0; x < tam; x++) {
    if (mod[y][x]) escuros++;
    if (y + 1 < tam && x + 1 < tam && mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) p += 3;
  }
  const total = tam * tam;
  p += (Math.ceil(Math.abs(escuros * 20 - total * 10) / total) - 1) * 10;
  return p;
}

function qrMatriz(texto) { return gerarMatriz(Array.from(Buffer.from(String(texto), 'utf8'))); }

function qrSvg(texto, opts) {
  opts = opts || {};
  const m = qrMatriz(texto), tam = m.length, margem = opts.margem === undefined ? 4 : opts.margem;
  const total = tam + margem * 2, px = (opts.modulo || 6) * total;
  let d = '';
  for (let y = 0; y < tam; y++) for (let x = 0; x < tam; x++) if (m[y][x]) d += 'M' + (x + margem) + ' ' + (y + margem) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges">' +
    '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

module.exports = { qrMatriz, qrSvg };
