'use strict';

const PDFDocument = require('pdfkit');
const { formatBRL, formatDateTime } = require('./util');

// Comprovante de RETIRADA de mercadoria no CD. Retorna um Buffer (PDF).
// dados = {
//   numero, criadoEm, retiradoEm (opcional),
//   empresa: { nome, cnpj, contato },
//   cliente: { nome, email },
//   linhas: [{ item_nome, quantidade, preco_centavos, total_centavos }],
//   totalItens, totalCentavos,
//   nf (opcional): { taxaBps, parcelaBps, impostoCentavos, baseCentavos, totalCentavos },
//   vencimento (opcional 'DD/MM/AAAA')
// }
function gerarComprovanteRetirada(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const C = { texto: '#1a1f27', suave: '#6b7480', linha: '#e2e6ec', faixa: '#f6f8fa', azul: '#1f4e8c' };
      const empresa = dados.empresa || {};
      const cliente = dados.cliente || {};
      const pct = (bps) => (bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace('.', ',')) + '%';

      // Cabecalho
      const topo = doc.y;
      doc.fillColor(C.azul).font('Helvetica-Bold').fontSize(15).text(empresa.nome || 'Sua Empresa', 48, topo);
      doc.font('Helvetica').fontSize(9).fillColor(C.suave);
      if (empresa.cnpj) doc.text('CNPJ ' + empresa.cnpj);
      if (empresa.contato) doc.text(empresa.contato);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(C.texto).text('Comprovante de retirada', 48, topo, { align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor(C.suave).text('#' + dados.numero, { align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(C.suave).text(formatDateTime(dados.criadoEm), { align: 'right' });

      doc.moveDown(1);
      const yL = doc.y + 4;
      doc.moveTo(48, yL).lineTo(547, yL).lineWidth(1).strokeColor(C.linha).stroke();
      doc.moveDown(1);

      // Cliente
      sec(doc, C, 'CLIENTE');
      doc.font('Helvetica').fontSize(11).fillColor(C.texto).text((cliente.nome || '-') + (cliente.email ? '  -  ' + cliente.email : ''));
      doc.moveDown(0.8);

      // Itens
      sec(doc, C, 'MERCADORIA RETIRADA');
      tabela(doc, C, dados.linhas || []);

      // Total
      const yT = doc.y + 6;
      doc.rect(48, yT, 499, 26).fill(C.faixa);
      doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11).text('Total  -  ' + (dados.totalItens || 0) + ' itens', 56, yT + 7);
      doc.text(formatBRL(dados.totalCentavos), 48, yT + 7, { width: 491, align: 'right' });
      doc.y = yT + 34;

      // NF (se houver)
      if (dados.nf && dados.nf.impostoCentavos > 0) {
        const nf = dados.nf;
        doc.font('Helvetica').fontSize(9.5).fillColor(C.suave)
          .text('Nota fiscal · imposto ' + pct(nf.taxaBps) + ' sobre ' + pct(nf.parcelaBps) + ' da retirada (' + formatBRL(Math.round(nf.baseCentavos * nf.parcelaBps / 10000)) + ')', 56, doc.y, { width: 360, continued: false });
        doc.y -= 12;
        doc.font('Helvetica').fontSize(9.5).fillColor(C.texto).text('+ ' + formatBRL(nf.impostoCentavos), 48, doc.y, { width: 491, align: 'right' });
        doc.moveDown(0.3);
        const yG = doc.y + 2;
        doc.rect(48, yG, 499, 24).fill('#eef3fb');
        doc.fillColor(C.azul).font('Helvetica-Bold').fontSize(11).text('Total a pagar (com nota fiscal)', 56, yG + 6);
        doc.text(formatBRL(nf.totalCentavos), 48, yG + 6, { width: 491, align: 'right' });
        doc.y = yG + 32;
      }

      // Extras
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9.5).fillColor(C.suave);
      const extras = ['Forma de retirada: no centro de distribuição (CD)'];
      if (dados.vencimento) extras.push('Vencimento do pagamento: ' + dados.vencimento);
      if (dados.retiradoEm) extras.push('Retirado em: ' + formatDateTime(dados.retiradoEm));
      doc.text(extras.join('    |    '), { width: 499 });

      // Assinaturas
      doc.moveDown(3.2);
      const yS = Math.min(doc.y, 690);
      const w = 230;
      doc.moveTo(60, yS).lineTo(60 + w, yS).lineWidth(0.8).strokeColor(C.texto).stroke();
      doc.moveTo(307, yS).lineTo(307 + w, yS).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(C.suave)
        .text('Responsável pela entrega (' + (empresa.nome || 'A4 Móveis') + ')', 60, yS + 5, { width: w, align: 'center' });
      doc.text('Quem retirou — nome e documento', 307, yS + 5, { width: w, align: 'center' });

      // Rodape (y seguro para não estourar para uma 2a pagina)
      doc.font('Helvetica').fontSize(8).fillColor(C.suave)
        .text('Documento de retirada de mercadoria. Guarde para seu controle.', 48, 770, { align: 'center', width: 499, lineBreak: false });

      doc.end();
    } catch (e) { reject(e); }
  });
}

function sec(doc, C, t) { doc.font('Helvetica-Bold').fontSize(8).fillColor('#8a93a0').text(t, { characterSpacing: 0.5 }); doc.moveDown(0.3); }
function tabela(doc, C, linhas) {
  const x = 48, larg = [300, 55, 70, 74];
  const heads = ['Produto', 'Qtd', 'Valor unit.', 'Total'];
  let y = doc.y + 2;
  doc.font('Helvetica').fontSize(8).fillColor('#8a93a0');
  linha(doc, x, y, larg, heads, ['left', 'right', 'right', 'right']);
  y += 16; doc.moveTo(x, y).lineTo(547, y).lineWidth(0.7).strokeColor(C.linha).stroke(); y += 4;
  doc.font('Helvetica').fontSize(9.5).fillColor(C.texto);
  linhas.forEach((l) => {
    const cols = [l.item_nome || '-', String(l.quantidade), formatBRL(l.preco_centavos), formatBRL(l.total_centavos)];
    const h = linha(doc, x, y, larg, cols, ['left', 'right', 'right', 'right']);
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

module.exports = { gerarComprovanteRetirada };
