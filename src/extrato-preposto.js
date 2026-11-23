'use strict';

const PDFDocument = require('pdfkit');
const { formatBRL, formatDateTime } = require('./util');

// Extrato do PREPOSTO de uma retirada (uso INTERNO — nunca vai para o cliente final).
// Mostra, por produto: preco de sistema, preco de venda, comissao (X) e acrescimo (Y).
// NAO mostra o percentual/valor do representante pai (Gabriel). Retorna um Buffer (PDF).
// dados = {
//   numero, criadoEm,
//   empresa: { nome, cnpj, contato },
//   cliente: { nome },
//   preposto: { nome, bps },           // bps = % de comissao do preposto (ex.: 400 = 4%)
//   linhas: [{ nome, qtd, baseCentavos, vendaCentavos, comissaoCentavos, adicionalCentavos }],
//   totComissao, totAdicional, totGeral
// }
function gerarExtratoPreposto(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const C = { texto: '#1a1f27', suave: '#6b7480', linha: '#e2e6ec', faixa: '#f6f8fa',
        verde: '#2f7d55', verdeBg: '#f2f9f4', ouro: '#9a7420', ouroBg: '#fbf6ea' };
      const L = 48, R = 547, W = R - L;
      const empresa = dados.empresa || {};
      const preposto = dados.preposto || {};
      const pct = (bps) => (bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace('.', ',')) + '%';

      // ---------- Cabecalho ----------
      const topo = doc.y;
      doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(15).text(empresa.nome || 'Sua Empresa', L, topo);
      doc.font('Helvetica').fontSize(9).fillColor(C.suave);
      if (empresa.cnpj) doc.text('CNPJ ' + empresa.cnpj);
      if (empresa.contato) doc.text(empresa.contato);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(C.texto).text('Extrato do representante', L, topo, { align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(C.suave).text('Retirada ' + dados.numero + '  ·  ' + formatDateTime(dados.criadoEm), { align: 'right' });
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.suave).text('Documento interno — não enviar ao cliente final', { align: 'right' });

      doc.moveDown(1);
      let y = doc.y + 2;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(C.linha).stroke();
      doc.y = y + 10;

      // ---------- Representante / cliente ----------
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.suave).text('REPRESENTANTE', L, doc.y);
      doc.font('Helvetica').fontSize(11.5).fillColor(C.texto)
        .text((preposto.nome || '—') + '   ·   comissão ' + pct(preposto.bps || 0) + ' sobre o preço de sistema');
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.suave).text('CLIENTE', L, doc.y);
      doc.font('Helvetica').fontSize(11.5).fillColor(C.texto).text((dados.cliente && dados.cliente.nome) || '—');
      doc.moveDown(0.9);

      // ---------- Tabela ----------
      // Colunas: Produto | Qtd | Sistema | Venda | Comissão (X) | Adicional (Y)
      const cols = [
        { x: L,   w: 168, align: 'left',  h: 'Produto / cor' },
        { x: 216, w: 34,  align: 'right', h: 'Qtd' },
        { x: 250, w: 70,  align: 'right', h: 'Sistema' },
        { x: 320, w: 70,  align: 'right', h: 'Venda' },
        { x: 390, w: 78,  align: 'right', h: 'Comissão' },
        { x: 468, w: 79,  align: 'right', h: 'Adicional' },
      ];
      const header = (yy) => {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.suave);
        cols.forEach((c) => doc.text(c.h.toUpperCase(), c.x, yy, { width: c.w, align: c.align }));
        doc.moveTo(L, yy + 14).lineTo(R, yy + 14).lineWidth(1).strokeColor(C.linha).stroke();
      };
      let yy = doc.y;
      header(yy);
      yy += 20;
      doc.font('Helvetica').fontSize(10);
      (dados.linhas || []).forEach((l) => {
        if (yy > 720) { doc.addPage(); yy = 60; header(yy); yy += 20; }
        const cell = (i, txt, color, bold) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(color || C.texto)
            .text(txt, cols[i].x, yy, { width: cols[i].w, align: cols[i].align });
        };
        const temAcr = (l.adicionalCentavos || 0) > 0;
        cell(0, l.nome || '—');
        cell(1, String(l.qtd || 0));
        cell(2, formatBRL(l.baseCentavos));
        cell(3, formatBRL(l.vendaCentavos), temAcr ? C.ouro : C.texto, temAcr);
        cell(4, formatBRL(l.comissaoCentavos), C.verde, true);
        cell(5, temAcr ? formatBRL(l.adicionalCentavos) : '—', temAcr ? C.ouro : C.suave, temAcr);
        const hNome = doc.heightOfString(l.nome || '—', { width: cols[0].w, align: 'left' });
        yy += Math.max(hNome, 14) + 8;
        doc.moveTo(L, yy - 4).lineTo(R, yy - 4).lineWidth(0.5).strokeColor(C.linha).stroke();
      });

      // ---------- Totais ----------
      yy += 8;
      if (yy > 700) { doc.addPage(); yy = 60; }
      const boxW = (W - 20) / 3, boxH = 56;
      const box = (x, titulo, valor, cor, bg, borda) => {
        doc.roundedRect(x, yy, boxW, boxH, 8).fillAndStroke(bg, borda);
        doc.font('Helvetica').fontSize(8.5).fillColor(C.suave).text(titulo.toUpperCase(), x + 12, yy + 11, { width: boxW - 24 });
        doc.font('Helvetica-Bold').fontSize(16).fillColor(cor).text(formatBRL(valor), x + 12, yy + 26, { width: boxW - 24 });
      };
      box(L, 'Comissão (X)', dados.totComissao, C.verde, C.verdeBg, '#d7ecdf');
      box(L + boxW + 10, 'Valor adicional (Y)', dados.totAdicional, C.ouro, C.ouroBg, '#ead9b0');
      // total destacado
      const xt = L + (boxW + 10) * 2;
      doc.roundedRect(xt, yy, boxW, boxH, 8).fillAndStroke('#eef3f8', '#cfdbe8');
      doc.font('Helvetica').fontSize(8.5).fillColor(C.suave).text('TOTAL A RECEBER (X + Y)', xt + 12, yy + 11, { width: boxW - 24 });
      doc.font('Helvetica-Bold').fontSize(17).fillColor(C.texto).text(formatBRL(dados.totGeral), xt + 12, yy + 27, { width: boxW - 24 });

      yy += boxH + 16;
      doc.font('Helvetica').fontSize(8.5).fillColor(C.suave)
        .text('Comissão (X) = ' + pct(preposto.bps || 0) + ' sobre o preço de sistema. Adicional (Y) = diferença entre o preço de venda e o de sistema (100% do representante). Valores sujeitos a conferência.', L, yy, { width: W });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { gerarExtratoPreposto };
