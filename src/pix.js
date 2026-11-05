'use strict';

// Pix "copia e cola" (BR Code estatico, padrao do Banco Central) com o valor do pedido.
// Dados do recebedor: variaveis de ambiente, com o padrao informado pela distribuidora.
const { qrSvg } = require('./qr');

const CFG = {
  chave: process.env.PIX_CHAVE || '45277258825',               // CPF, so numeros
  nome: process.env.PIX_NOME || 'THIAGO RAFAEL DE ABREU',
  cidade: process.env.PIX_CIDADE || 'TANABI',
  whatsapp: process.env.PIX_WHATSAPP || '5515991262956',        // aviso de pagamento (Gabriel)
};

function ascii(s, max) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 .\-]/g, '').toUpperCase().trim().slice(0, max);
}
function campo(id, valor) { return id + String(valor.length).padStart(2, '0') + valor; }
function crc16(s) {
  let c = 0xffff;
  for (const b of Buffer.from(s, 'utf8')) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}

// valorCentavos: inteiro; txid: identificador do pedido (ex.: DS-1051 -> DS1051)
function payload(valorCentavos, txid) {
  const conta = campo('00', 'BR.GOV.BCB.PIX') + campo('01', CFG.chave);
  const tx = (String(txid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25)) || '***';
  let p = campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986');
  if (valorCentavos > 0) p += campo('54', (valorCentavos / 100).toFixed(2));
  p += campo('58', 'BR') + campo('59', ascii(CFG.nome, 25)) + campo('60', ascii(CFG.cidade, 15)) + campo('62', campo('05', tx)) + '6304';
  return p + crc16(p);
}

function chaveFormatada() {
  const k = CFG.chave;
  return /^\d{11}$/.test(k) ? k.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : k;
}
function favorecido() {
  const t = (s) => String(s).toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/ (De|Da|Do|Dos|Das|E) /g, (m) => m.toLowerCase());
  return t(CFG.nome) + ' · ' + t(CFG.cidade);
}

// Dados prontos para a tela de pagamento de um lancamento do financeiro.
function dadosPagamento(numero, valorCentavos, valorTxt) {
  const cod = payload(valorCentavos, numero);
  const msg = 'Olá! Paguei o pedido ' + numero + ' no valor de ' + valorTxt + ' via Pix. Segue o comprovante.';
  return {
    codigo: cod, qr: qrSvg(cod, { modulo: 5, margem: 3 }), chave: chaveFormatada(), chaveCopia: CFG.chave,
    favorecido: favorecido(), whatsapp: 'https://wa.me/' + CFG.whatsapp + '?text=' + encodeURIComponent(msg),
  };
}

module.exports = { payload, dadosPagamento, crc16 };
