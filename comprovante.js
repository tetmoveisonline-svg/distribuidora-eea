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

      // ---------- Totais (com desconto) ----------
      const subtotal = (dados.subtotalCentavos != null) ? dados.subtotalCentavos : dados.totalCentavos;
      const descItens = dados.descontoItensCentavos || 0;
      const descTotal = dados.descontoTotalCentavos || 0;
      const rx = 320, rw = 227;
      let yT = doc.y + 10;
      function resumo(label, valor, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(C.texto);
        doc.text(label, rx, yT, { width: rw });
        doc.text(valor, rx, yT, { width: rw, align: 'right' });
        yT += bold ? 20 : 16;
      }
      resumo('Subtotal (' + (dados.totalEtiquetas || 0) + ' etiquetas)', formatBRL(subtotal));
      if (descItens > 0) resumo('Desconto nos itens', '- ' + formatBRL(descItens));
      if (descTotal > 0) resumo('Desconto no total', '- ' + formatBRL(descTotal));
      doc.moveTo(rx, yT).lineTo(547, yT).lineWidth(1).strokeColor(C.linha).stroke();
      yT += 8;
      resumo('Total', formatBRL(dados.totalCentavos), true);
      doc.y = yT + 6;

      // ---------- Extras ----------
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(9.5).fillColor(C.suave);
      const extras = [];
      if (dados.formaPagamento) extras.push('Forma de pagamento: ' + dados.formaPagamento);
      if (dados.prazoDespacho) extras.push('Prazo de despacho: ' + dados.prazoDespacho);
      extras.push('Observacoes: ' + (dados.observacoes && dados.observacoes.trim() ? dados.observacoes : '-'));
      doc.text(extras.join('    |    '), 48, doc.y, { width: 499 });

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
  const larguras = [179, 40, 80, 80, 90]; // produto(cor), qtd, unit, desconto, total
  const aligns = ['left', 'right', 'right', 'right', 'right'];
  const heads = ['Produto (cor)', 'Qtd', 'Valor unit.', 'Desconto', 'Total'];
  let y = doc.y + 2;

  doc.font('Helvetica').fontSize(8).fillColor('#8a93a0');
  desenharLinha(doc, x, y, larguras, heads, aligns);
  y += 16;
  doc.moveTo(x, y).lineTo(547, y).lineWidth(0.7).strokeColor(C.linha).stroke();
  y += 4;

  doc.font('Helvetica').fontSize(9.5).fillColor(C.texto);
  linhas.forEach((l) => {
    const nome = (l.item_nome || '-') + (l.cor_nome ? '  (' + l.cor_nome + ')' : '');
    const desc = l.desconto_centavos > 0 ? '- ' + formatBRL(l.desconto_centavos) : '—';
    const cols = [nome, String(l.quantidade), formatBRL(l.preco_centavos), desc, formatBRL(l.total_centavos)];
    const alturaLinha = desenharLinha(doc, x, y, larguras, cols, aligns);
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
