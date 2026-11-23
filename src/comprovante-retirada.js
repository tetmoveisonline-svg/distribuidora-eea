'use strict';

const PDFDocument = require('pdfkit');
const { formatBRL, formatDateTime } = require('./util');
const { qrMatriz } = require('./qr');

// Comprovante de RETIRADA no mesmo padrao do comprovante normal (cabecalho, bloco de Pix com
// vencimento, etc.), mais o bloco de retirada com assinaturas. Retorna um Buffer (PDF).
// dados = {
//   numero, criadoEm, retiradoEm,
//   empresa: { nome, cnpj, contato },
//   cliente: { nome, email },
//   linhas: [{ item_nome, quantidade, preco_centavos, total_centavos }],
//   totalItens, baseCentavos, totalCentavos (a pagar = base + imposto),
//   nf (opcional): { taxaBps, parcelaBps, impostoCentavos, baseCentavos, totalCentavos },
//   pagamento (opcional): { parcelado, codigo, chave, favorecido, valorCentavos, vencimento },
//   parcelas (opcional, quando parcelado): [{ num, total, venc, valor }],
// }
function gerarComprovanteRetirada(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const C = {
        texto: '#1a1f27', suave: '#6b7480', linha: '#e2e6ec', faixa: '#f6f8fa',
        aceiteBg: '#f2f9f4', aceiteBorda: '#d7ecdf', aceiteTexto: '#1f5f3d', verde: '#2f7d55',
      };
      const empresa = dados.empresa || {};
      const cliente = dados.cliente || {};
      const base = Number(dados.baseCentavos != null ? dados.baseCentavos : dados.totalCentavos) || 0;
      const pct = (bps) => (bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace('.', ',')) + '%';
      const pesoG = Number(dados.pesoTotalGramas) || 0;
      const pesoTxt = pesoG > 0 ? (pesoG / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kg' : '';

      // ---------- Cabecalho ----------
      const topo = doc.y;
      doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(15).text(empresa.nome || 'Sua Empresa', 48, topo);
      doc.font('Helvetica').fontSize(9).fillColor(C.suave);
      if (empresa.cnpj) doc.text('CNPJ ' + empresa.cnpj);
      if (empresa.contato) doc.text(empresa.contato);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(C.texto).text('Comprovante de retirada', 48, topo, { align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(C.suave).text('#' + dados.numero + '  ·  ' + formatDateTime(dados.criadoEm), { align: 'right' });

      doc.moveDown(1);
      const yL = doc.y + 4;
      doc.moveTo(48, yL).lineTo(547, yL).lineWidth(1).strokeColor(C.linha).stroke();
      doc.moveDown(1);

      // ---------- Cliente ----------
      sec(doc, C, 'CLIENTE');
      doc.font('Helvetica').fontSize(11).fillColor(C.texto).text((cliente.nome || '-') + (cliente.email ? '  -  ' + cliente.email : ''));
      doc.moveDown(0.8);

      // ---------- Itens ----------
      sec(doc, C, 'MERCADORIA RETIRADA');
      tabela(doc, C, dados.linhas || []);

      // ---------- Total (mercadoria) ----------
      const yT = doc.y + 6;
      doc.rect(48, yT, 499, 26).fill(C.faixa);
      doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11).text('Total  -  ' + (dados.totalItens || 0) + ' itens' + (pesoTxt ? '  ·  ' + pesoTxt : ''), 56, yT + 7);
      doc.text(formatBRL(base), 48, yT + 7, { width: 491, align: 'right' });
      doc.y = yT + 34;

      // ---------- NF (imposto) ----------
      if (dados.nf && dados.nf.impostoCentavos > 0) {
        const nf = dados.nf;
        const yN = doc.y;
        doc.font('Helvetica').fontSize(9.5).fillColor(C.suave)
          .text('Nota fiscal · imposto ' + pct(nf.taxaBps) + ' sobre ' + pct(nf.parcelaBps) + ' da retirada', 56, yN, { width: 360 });
        doc.font('Helvetica').fontSize(9.5).fillColor(C.texto).text('+ ' + formatBRL(nf.impostoCentavos), 48, yN, { width: 491, align: 'right' });
        doc.moveDown(0.3);
        const yG = doc.y + 2;
        doc.rect(48, yG, 499, 24).fill(C.faixa);
        doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11).text('Total a pagar (com nota fiscal)', 56, yG + 6);
        doc.text(formatBRL(dados.totalCentavos), 48, yG + 6, { width: 491, align: 'right' });
        doc.y = yG + 32;
      }

      // ---------- Extras ----------
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9.5).fillColor(C.suave);
      const extras = ['Forma de retirada: no centro de distribuição (CD)'];
      if (dados.pagamento && !dados.pagamento.parcelado && dados.pagamento.vencimento) extras.push('Vencimento: ' + dados.pagamento.vencimento);
      if (dados.retiradoEm) extras.push('Retirado em: ' + formatDateTime(dados.retiradoEm));
      doc.text(extras.join('    |    '), { width: 499 });

      // ---------- Pagamento (Pix) ----------
      if (dados.pagamento) {
        if (dados.pagamento.parcelado) blocoPagamentoParcelado(doc, C, dados.pagamento, dados.parcelas || []);
        else blocoPagamentoVista(doc, C, dados.pagamento);
      }

      // ---------- Retirada (assinaturas) ----------
      doc.moveDown(1);
      const yR = doc.y;
      doc.roundedRect(48, yR, 499, 86, 6).lineWidth(1).fillAndStroke(C.aceiteBg, C.aceiteBorda);
      doc.fillColor(C.aceiteTexto).font('Helvetica-Bold').fontSize(10).text('Retirada no centro de distribuição.', 60, yR + 10);
      doc.font('Helvetica').fontSize(9.5).fillColor('#2c4636').text('Confira os itens no ato da retirada e colete a assinatura de quem recebe a mercadoria.', 60, yR + 26, { width: 475 });
      const ys = yR + 62, w = 215;
      doc.moveTo(60, ys).lineTo(60 + w, ys).lineWidth(0.8).strokeColor('#9ab6a6').stroke();
      doc.moveTo(320, ys).lineTo(320 + w, ys).stroke();
      doc.font('Helvetica').fontSize(8.5).fillColor('#3a5a49')
        .text('Responsável pela entrega (' + (empresa.nome || 'A4 Móveis') + ')', 60, ys + 4, { width: w, align: 'center' });
      doc.text('Quem retirou — nome e documento', 320, ys + 4, { width: w, align: 'center' });

      // ---------- Rodape ----------
      doc.font('Helvetica').fontSize(8).fillColor(C.suave)
        .text('Documento de retirada de mercadoria. Guarde para seu controle.', 48, Math.min(doc.y + 24, 768), { align: 'center', width: 499, lineBreak: false });

      doc.end();
    } catch (e) { reject(e); }
  });
}

// Pagamento à vista: QR com o valor preenchido + vencimento em destaque (igual ao comprovante normal).
function blocoPagamentoVista(doc, C, pg) {
  doc.moveDown(1.2); doc.x = 48;
  sec(doc, C, 'PAGAMENTO');
  const y = doc.y + 2, alt = 146;
  doc.roundedRect(48, y, 499, alt, 6).lineWidth(1).strokeColor(C.linha).stroke();
  desenharQr(doc, pg.codigo, 60, y + 14, 118);
  const vx = 410, vw = 125;
  doc.roundedRect(vx, y + 14, vw, 52, 5).fill('#fff6e5');
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#9a6b12').text('VENCIMENTO', vx, y + 22, { width: vw, align: 'center', characterSpacing: 0.5 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#7a4f00').text(pg.vencimento || '-', vx, y + 36, { width: vw, align: 'center' });
  const tx = 192, tw = 205;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.texto).text('Pague com Pix', tx, y + 14, { width: tw });
  doc.font('Helvetica').fontSize(8.5).fillColor(C.suave).text('Abra o app do banco > Pix > Ler QR Code. O valor já vem preenchido.', tx, y + 30, { width: tw });
  linhaKV(doc, C, 'Valor', formatBRL(pg.valorCentavos), tx, y + 58, true);
  linhaKV(doc, C, 'Chave Pix', pg.chave, tx, y + 76);
  linhaKV(doc, C, 'Favorecido', pg.favorecido, tx, y + 92);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.suave).text('Copia e cola', tx, y + 110, { width: 62 });
  doc.font('Courier').fontSize(6.6).fillColor('#4a525c').text(pg.codigo, tx + 64, y + 110, { width: 281, lineGap: 0.5 });
  doc.x = 48; doc.y = y + alt;
}

// Pagamento parcelado: QR SEM valor (a pessoa le e digita o valor da parcela) + lista das parcelas.
function blocoPagamentoParcelado(doc, C, pg, parcelas) {
  doc.moveDown(1.2); doc.x = 48;
  sec(doc, C, 'PAGAMENTO · PARCELADO');
  const y = doc.y + 2, altTopo = 134;
  doc.roundedRect(48, y, 499, altTopo, 6).lineWidth(1).strokeColor(C.linha).stroke();
  desenharQr(doc, pg.codigo, 60, y + 14, 118);
  const tx = 192, tw = 345;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.texto).text('Pague cada parcela com Pix', tx, y + 14, { width: tw });
  doc.font('Helvetica').fontSize(8.5).fillColor(C.suave).text('Leia o QR Code e DIGITE o valor da parcela que está pagando (o QR não vem com valor).', tx, y + 30, { width: tw });
  linhaKV(doc, C, 'Chave Pix', pg.chave, tx, y + 56);
  linhaKV(doc, C, 'Favorecido', pg.favorecido, tx, y + 72);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.suave).text('Copia e cola', tx, y + 90, { width: 62 });
  doc.font('Courier').fontSize(6.6).fillColor('#4a525c').text(pg.codigo, tx + 64, y + 90, { width: tw - 64, lineGap: 0.5 });
  doc.y = y + altTopo + 8;

  // Tabela das parcelas
  const x = 48, larg = [120, 150, 110];
  let yy = doc.y;
  doc.font('Helvetica').fontSize(8).fillColor('#8a93a0');
  linha(doc, x, yy, larg, ['Parcela', 'Vencimento', 'Valor'], ['left', 'left', 'right']);
  yy += 15; doc.moveTo(x, yy).lineTo(428, yy).lineWidth(0.7).strokeColor(C.linha).stroke(); yy += 4;
  doc.font('Helvetica').fontSize(9.5).fillColor(C.texto);
  parcelas.forEach((p) => {
    linha(doc, x, yy, larg, [p.num + ' de ' + p.total, p.venc, formatBRL(p.valor)], ['left', 'left', 'right']);
    yy += 17; doc.moveTo(x, yy - 4).lineTo(428, yy - 4).lineWidth(0.5).strokeColor('#eef1f5').stroke();
  });
  doc.y = yy;
}

function desenharQr(doc, codigo, qx, qy, lado) {
  const m = qrMatriz(codigo), n = m.length, mod = lado / (n + 4);
  doc.rect(qx, qy, lado, lado).fill('#ffffff');
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) doc.rect(qx + (c + 2) * mod, qy + (r + 2) * mod, mod + 0.05, mod + 0.05);
  doc.fill('#000000');
}
function linhaKV(doc, C, rot, val, tx, yy, bold) {
  doc.font('Helvetica').fontSize(8.5).fillColor(C.suave).text(rot, tx, yy, { width: 62 });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor(C.texto).text(val, tx + 64, yy - (bold ? 1.5 : 0), { width: 281 });
}
function sec(doc, C, t) { doc.font('Helvetica-Bold').fontSize(8).fillColor('#8a93a0').text(t, { characterSpacing: 0.5 }); doc.moveDown(0.3); }
function tabela(doc, C, linhas) {
  const x = 48, larg = [300, 55, 70, 74];
  let y = doc.y + 2;
  doc.font('Helvetica').fontSize(8).fillColor('#8a93a0');
  linha(doc, x, y, larg, ['Produto', 'Qtd', 'Valor unit.', 'Total'], ['left', 'right', 'right', 'right']);
  y += 16; doc.moveTo(x, y).lineTo(547, y).lineWidth(0.7).strokeColor(C.linha).stroke(); y += 4;
  doc.font('Helvetica').fontSize(9.5).fillColor(C.texto);
  linhas.forEach((l) => {
    const h = linha(doc, x, y, larg, [l.item_nome || '-', String(l.quantidade), formatBRL(l.preco_centavos), formatBRL(l.total_centavos)], ['left', 'right', 'right', 'right']);
    y += h + 6; doc.moveTo(x, y - 3).lineTo(547, y - 3).lineWidth(0.5).strokeColor('#eef1f5').stroke();
  });
  doc.y = y;
}
function linha(doc, x, y, larg, cols, al) {
  let cx = x, maxH = 12;
  for (let i = 0; i < cols.length; i++) { const h = doc.heightOfString(cols[i], { width: larg[i] }); if (h > maxH) maxH = h; }
  for (let i = 0; i < cols.length; i++) { doc.text(cols[i], cx, y, { width: larg[i], align: al[i] }); cx += larg[i] + 5; }
  return maxH;
}

// Monta o objeto do comprovante a partir do pedido (p, com cliente_nome/email), das linhas e dos
// lancamentos do financeiro (finRows com valor_centavos, venc_br, parcela_num, parcela_total).
function montarDados(p, linhasRows, finRows) {
  const pix = require('./pix');
  const base = Number(p.total_centavos) - (Number(p.imposto_centavos) || 0);
  const total = Number(p.total_centavos);
  const parceladas = (finRows || []).filter((f) => f.parcela_num != null).sort((a, b) => a.parcela_num - b.parcela_num);
  let pagamento = null, parcelas = null;
  if (parceladas.length > 0) {
    parcelas = parceladas.map((f) => ({ num: f.parcela_num, total: f.parcela_total, venc: f.venc_br, valor: Number(f.valor_centavos) }));
    const d = pix.dadosPagamento(p.numero, 0, ''); // QR sem valor: a pessoa digita o valor da parcela
    pagamento = { parcelado: true, codigo: d.codigo, chave: d.chave, favorecido: d.favorecido };
  } else if (finRows && finRows.length) {
    const f = finRows[0];
    const aPagar = Number(f.valor_centavos);
    const d = pix.dadosPagamento(p.numero, aPagar, '');
    pagamento = { parcelado: false, codigo: d.codigo, chave: d.chave, favorecido: d.favorecido, valorCentavos: aPagar, vencimento: f.venc_br };
  }
  const pesoTotalGramas = (linhasRows || []).reduce((s, l) => s + (Number(l.peso_gramas) || 0) * (Number(l.quantidade) || 0), 0);
  return {
    numero: p.numero, criadoEm: p.aceite_em || p.criado_em, retiradoEm: p.retirado_em,
    empresa: { nome: process.env.EMPRESA_NOME || 'A4 Móveis Distribuidora', cnpj: process.env.EMPRESA_CNPJ || '', contato: process.env.EMPRESA_CONTATO || '' },
    cliente: { nome: p.cliente_nome, email: p.cliente_email },
    linhas: linhasRows, totalItens: p.total_etiquetas, pesoTotalGramas, baseCentavos: base, totalCentavos: total,
    nf: p.com_nf ? { taxaBps: p.nf_bps, parcelaBps: p.nf_parcela_bps, impostoCentavos: p.imposto_centavos, baseCentavos: base, totalCentavos: total } : null,
    pagamento, parcelas,
  };
}

module.exports = { gerarComprovanteRetirada, montarDados };
