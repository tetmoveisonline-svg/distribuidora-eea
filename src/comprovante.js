'use strict';

const PDFDocument = require('pdfkit');
const { formatBRL, formatDateTime } = require('./util');

// Gera o comprovante/relatorio em PDF e retorna um Buffer.
// dados = {
//   numero, criadoEm, aceiteEm, aceiteIp,
//   empresa: { nome, cnpj, contato },
//   cliente: { nome, email },
//   linhas: [{ arquivo_nome, item_nome, quantidade, preco_centavos, total_centavos }],
//   totalEtiquetas, totalCentavos,
//   formaPagamento, prazoDespacho, observacoes
// }
function gerarComprovante(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const C = {
        texto: '#1a1f27',
        suave: '#6b7480',
        linha: '#e2e6ec',
        faixa: '#f6f8fa',
        aceiteBg: '#f2f9f4',
        aceiteBorda: '#d7ecdf',
        aceiteTexto: '#1f5f3d',
        verde: '#2f7d55',
      };

      const empresa = dados.empresa || {};
      const cliente = dados.cliente || {};

      // ---------- Cabecalho ----------
      const topo = doc.y;
      doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(15).text(empresa.nome || 'Sua Empresa', 48, topo);
      doc.font('Helvetica').fontSize(9).fillColor(C.suave);
      if (empresa.cnpj) doc.text('CNPJ ' + empresa.cnpj);
      if (empresa.contato) doc.text(empresa.contato);

      // Numero do pedido (a direita).
      doc.font('Helvetica-Bold').fontSize(14).fillColor(C.texto)
        .text('#' + dados.numero, 48, topo, { align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(C.suave)
        .text(formatDateTime(dados.criadoEm), { align: 'right' });

      doc.moveDown(1);
      const yLinha = doc.y + 4;
      doc.moveTo(48, yLinha).lineTo(547, yLinha).lineWidth(1).strokeColor(C.linha).stroke();
      doc.moveDown(1);

      // ---------- Cliente ----------
      secTitulo(doc, C, 'CLIENTE');
      doc.font('Helvetica').fontSize(11).fillColor(C.texto)
        .text((cliente.nome || '-') + (cliente.email ? '  -  ' + cliente.email : ''));
      doc.moveDown(0.8);

      // ---------- Tabela de envios ----------
      secTitulo(doc, C, 'ENVIOS');
      desenharTabela(doc, C, dados.linhas || []);

      // ---------- Total ----------
      const yT = doc.y + 6;
      doc.rect(48, yT, 499, 26).fill(C.faixa);
      doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11)
        .text('Total  -  ' + (dados.totalEtiquetas || 0) + ' etiquetas', 56, yT + 7, { continued: false });
      doc.text(formatBRL(dados.totalCentavos), 48, yT + 7, { width: 491, align: 'right' });
      doc.y = yT + 34;

      // ---------- Extras ----------
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(9.5).fillColor(C.suave);
      const extras = [];
      if (dados.formaPagamento) extras.push('Forma de pagamento: ' + dados.formaPagamento);
      if (dados.prazoDespacho) extras.push('Prazo de despacho: ' + dados.prazoDespacho);
      extras.push('Observacoes: ' + (dados.observacoes && dados.observacoes.trim() ? dados.observacoes : '-'));
      doc.text(extras.join('    |    '), { width: 499 });

      // ---------- Bloco de aceite ----------
      doc.moveDown(1);
      const yA = doc.y;
      const alturaA = 54;
      doc.roundedRect(48, yA, 499, alturaA, 6).lineWidth(1).fillAndStroke(C.aceiteBg, C.aceiteBorda);
      doc.fillColor(C.aceiteTexto).font('Helvetica-Bold').fontSize(10)
        .text('Aceite registrado.', 60, yA + 10);
      doc.font('Helvetica').fontSize(9.5).fillColor('#2c4636').text(
        'O cliente declara que confirmou os envios e os valores negociados listados acima, em '
        + formatDateTime(dados.aceiteEm) + (dados.aceiteIp ? '.  IP: ' + dados.aceiteIp + '.' : '.'),
        60, yA + 26, { width: 475 }
      );

      // ---------- Rodape ----------
      doc.font('Helvetica').fontSize(8).fillColor(C.suave)
        .text('Documento gerado pela Central de Postagem. Comprovante permanente do aceite.', 48, 792, { align: 'center', width: 499 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function secTitulo(doc, C, txt) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#8a93a0')
    .text(txt, { characterSpacing: 0.5 });
  doc.moveDown(0.3);
}

function desenharTabela(doc, C, linhas) {
  const x = 48;
  const larguras = [200, 120, 40, 65, 74]; // arquivo, item, qtd, unit, total
  const heads = ['Etiqueta / arquivo', 'Item', 'Qtd', 'Valor unit.', 'Total'];
  let y = doc.y + 2;

  // cabecalho
  doc.font('Helvetica').fontSize(8).fillColor('#8a93a0');
  desenharLinha(doc, x, y, larguras, heads, ['left', 'left', 'right', 'right', 'right']);
  y += 16;
  doc.moveTo(x, y).lineTo(547, y).lineWidth(0.7).strokeColor(C.linha).stroke();
  y += 4;

  doc.font('Helvetica').fontSize(9.5).fillColor(C.texto);
  linhas.forEach((l) => {
    const cols = [
      l.arquivo_nome || '-',
      l.item_nome || '-',
      String(l.quantidade),
      formatBRL(l.preco_centavos),
      formatBRL(l.total_centavos),
    ];
    const alturaLinha = desenharLinha(doc, x, y, larguras, cols, ['left', 'left', 'right', 'right', 'right']);
    y += alturaLinha + 6;
    doc.moveTo(x, y - 3).lineTo(547, y - 3).lineWidth(0.5).strokeColor('#eef1f5').stroke();
  });
  doc.y = y;
}

function desenharLinha(doc, x, y, larguras, cols, aligns) {
  let cx = x;
  let maxH = 12;
  for (let i = 0; i < cols.length; i++) {
    const w = larguras[i];
    const h = doc.heightOfString(cols[i], { width: w });
    if (h > maxH) maxH = h;
  }
  for (let i = 0; i < cols.length; i++) {
    const w = larguras[i];
    doc.text(cols[i], cx, y, { width: w, align: aligns[i] });
    cx += w + 5;
  }
  return maxH;
}

module.exports = { gerarComprovante };
