'use strict';

// Lista de precos em PDF (botao "Baixar lista de precos" na tela Estoque).
// Recebe os produtos no mesmo formato de estoque.saldosParaCliente / saldosSugerido,
// entao os precos sao exatamente os da tela de Estoque de quem baixou.

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { formatBRL, formatDateTime } = require('./util');

const C = {
  navy: '#0b2f6b', azul: '#0a4aa3', claro: '#039be5', ceu: '#e8f4fd', texto: '#16213a', suave: '#5d687c',
  linha: '#dfe6f0', chip: '#f3f6fa', ok: '#2f7d55',
};
const M = 36;              // margem
const W = 595.28 - 2 * M;  // largura util (A4)
const COL = { prod: 300, med: 92, peso: 52 }; // preco = resto
const LOGO = path.join(__dirname, '..', 'public', 'img', 'logo.png');

function medTxt(m) { return m ? String(m).trim().replace(/\s*cm\.?$/i, '').replace(/\s*[xX]\s*/g, ' × ') : '—'; }
function pesoTxt(g) {
  if (g === null || g === undefined || g === '') return '—';
  return (Number(g) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' kg';
}

// Layout dos chips de cor dentro da coluna do produto; devolve a altura usada.
function chips(doc, cores, x, y, largura, desenhar) {
  if (!cores || !cores.length) return 0;
  const h = 12, gap = 4;
  let cx = x, cy = y;
  for (const c of cores) {
    doc.font('Helvetica').fontSize(7.5);
    const tNome = String(c.nome || '');
    const wNome = doc.widthOfString(tNome);
    doc.font('Courier').fontSize(6.5);
    const tSku = c.sku ? String(c.sku) : '';
    const wSku = tSku ? doc.widthOfString(tSku) + 4 : 0;
    const w = wNome + wSku + 12;
    if (cx + w > x + largura && cx > x) { cx = x; cy += h + 3; }
    if (desenhar) {
      doc.roundedRect(cx, cy, w, h, 6).fillAndStroke(C.chip, C.linha);
      doc.fillColor(C.texto).font('Helvetica').fontSize(7.5).text(tNome, cx + 6, cy + 2.6, { lineBreak: false });
      if (tSku) doc.fillColor(C.suave).font('Courier').fontSize(6.5).text(tSku, cx + 6 + wNome + 4, cy + 3.2, { lineBreak: false });
    }
    cx += w + gap;
  }
  return cy + h - y;
}

function cabecalhoTabela(doc, y) {
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.suave);
  doc.text('PRODUTO E CORES', M + 4, y, { characterSpacing: 0.6, lineBreak: false });
  doc.text('MEDIDAS (CM)', M + COL.prod, y, { width: COL.med, align: 'center', characterSpacing: 0.6, lineBreak: false });
  doc.text('PESO', M + COL.prod + COL.med, y, { width: COL.peso, align: 'center', characterSpacing: 0.6, lineBreak: false });
  doc.text('PREÇO', M + COL.prod + COL.med + COL.peso, y, { width: W - COL.prod - COL.med - COL.peso - 4, align: 'right', characterSpacing: 0.6, lineBreak: false });
  doc.moveTo(M, y + 12).lineTo(M + W, y + 12).lineWidth(1.5).strokeColor(C.navy).stroke();
  return y + 18;
}

// produtos: [{ nome, peso_gramas, medidas, preco_centavos, preco_original, promo, promo_rotulo, cores:[{nome, sku}] }]
// opts: { para (nome de quem baixou), empresa, contato, site, negociado (true = cliente) }
function gerarListaPrecos(produtos, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: 'Lista de Preços', Author: opts.empresa || '' } });
      const out = [];
      doc.on('data', (c) => out.push(c));
      doc.on('end', () => resolve(Buffer.concat(out)));
      doc.on('error', reject);

      const agora = formatDateTime(new Date()); // dd/mm/aaaa, hh:mm
      const quando = agora.slice(0, 10) + ' às ' + agora.slice(12);
      const BOT = 842 - M - 18; // limite inferior do conteudo (rodape abaixo)

      // ---------- faixa do topo ----------
      const hTopo = 66;
      const grad = doc.linearGradient(M, M, M + W, M + hTopo);
      grad.stop(0, C.navy).stop(0.6, C.azul).stop(1, C.claro);
      doc.roundedRect(M, M, W, hTopo, 10).fill(grad);
      doc.roundedRect(M + 14, M + 13, 132, 40, 7).fill('#ffffff');
      if (fs.existsSync(LOGO)) { try { doc.image(LOGO, M + 22, M + 18, { fit: [116, 30], align: 'center', valign: 'center' }); } catch (e) { /* sem logo */ } }
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text('Lista de Preços', M, M + 15, { width: W - 16, align: 'right', lineBreak: false });
      doc.fillColor('#d6e8ff').font('Helvetica').fontSize(8.5)
        .text((opts.para ? opts.para + ' · ' : '') + 'gerada em ' + quando, M, M + 41, { width: W - 16, align: 'right', lineBreak: false });

      // ---------- avisos ----------
      let y = M + hTopo + 10;
      const avisos = [
        [opts.negociado ? 'Seu preço por unidade.' : 'Preço sugerido por unidade.', opts.negociado ? ' Inclui os preços negociados com você e as promoções do dia.' : ' Valores do sistema, iguais aos da tela de Estoque.'],
        ['Cores e códigos.', ' Cada cor aparece com o seu código (SKU) para facilitar o pedido.'],
        ['Pronta entrega', ' sujeita ao estoque do dia. Confirme a disponibilidade no pedido.'],
      ];
      const wAv = (W - 16) / 3;
      avisos.forEach((a, i) => {
        const x = M + i * (wAv + 8);
        doc.roundedRect(x, y, wAv, 38, 7).fill(C.ceu);
        doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(7.5).text(a[0], x + 8, y + 7, { width: wAv - 16, continued: true })
          .fillColor(C.suave).font('Helvetica').text(a[1]);
      });
      y += 48;
      y = cabecalhoTabela(doc, y);

      // ---------- linhas ----------
      const xMed = M + COL.prod, xPeso = xMed + COL.med, xPreco = xPeso + COL.peso, wPreco = W - COL.prod - COL.med - COL.peso - 4;
      for (const p of produtos) {
        doc.font('Helvetica-Bold').fontSize(9);
        const hNome = doc.heightOfString(String(p.nome || ''), { width: COL.prod - 10 });
        const hChips = chips(doc, p.cores, M + 4, 0, COL.prod - 10, false);
        const hPreco = p.promo ? 30 : 12;
        const h = Math.max(hNome + (hChips ? hChips + 5 : 0), hPreco) + 12;
        if (y + h > BOT) { doc.addPage(); y = cabecalhoTabela(doc, M); }
        const y0 = y + 6;
        doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(9).text(String(p.nome || ''), M + 4, y0, { width: COL.prod - 10 });
        if (hChips) chips(doc, p.cores, M + 4, y0 + hNome + 4, COL.prod - 10, true);
        doc.fillColor(C.suave).font('Helvetica').fontSize(8)
          .text(medTxt(p.medidas), xMed, y0 + 1, { width: COL.med, align: 'center', lineBreak: false })
          .text(pesoTxt(p.peso_gramas), xPeso, y0 + 1, { width: COL.peso, align: 'center', lineBreak: false });
        doc.fillColor(p.promo ? C.ok : C.navy).font('Helvetica-Bold').fontSize(10)
          .text(formatBRL(p.preco_centavos), xPreco, y0, { width: wPreco, align: 'right', lineBreak: false });
        if (p.promo) {
          doc.fillColor(C.suave).font('Helvetica').fontSize(6.8)
            .text('de ' + formatBRL(p.preco_original), xPreco - 60, y0 + 13, { width: wPreco + 60, align: 'right', lineBreak: false });
          if (p.promo_rotulo) doc.fillColor(C.ok).text(p.promo_rotulo, xPreco - 100, y0 + 21.5, { width: wPreco + 100, align: 'right', lineBreak: false });
        }
        y += h;
        doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(C.linha).stroke();
      }
      if (!produtos.length) {
        doc.fillColor(C.suave).font('Helvetica').fontSize(10).text('Nenhum produto com preço no momento.', M, y + 12);
        y += 30;
      }

      // ---------- fechamento ----------
      const hFim = 46;
      if (y + 12 + hFim > BOT) { doc.addPage(); y = M; } else y += 12;
      const temZap = !!opts.contato;
      const wObs = temZap ? W * 0.58 : W;
      doc.roundedRect(M, y, wObs, hFim, 8).lineWidth(0.8).strokeColor(C.linha).stroke();
      doc.fillColor(C.suave).font('Helvetica').fontSize(7.5).text(
        produtos.length + ' produtos. Preços sujeitos a alteração sem aviso prévio e à disponibilidade de estoque. ' +
        'Estoque e preços sempre atualizados no sistema' + (opts.site ? ': ' + opts.site : '.'), M + 10, y + 9, { width: wObs - 20 });
      if (temZap) {
        const x = M + wObs + 8, w = W - wObs - 8;
        doc.roundedRect(x, y, w, hFim, 8).fill(C.navy);
        doc.fillColor('#9fd8ff').font('Helvetica-Bold').fontSize(6.5).text('PEDIDOS E DÚVIDAS', x, y + 9, { width: w, align: 'center', characterSpacing: 1 });
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text(opts.contato, x, y + 20, { width: w, align: 'center', lineBreak: false });
      }

      // ---------- rodape com paginas ----------
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0; // o rodape fica abaixo da margem: sem isso o pdfkit abriria pagina nova
        const yr = 842 - M + 6;
        doc.fillColor('#8a94a6').font('Helvetica').fontSize(7)
          .text((opts.empresa || '') + ' · Lista de preços · ' + agora.slice(0, 10), M, yr, { lineBreak: false })
          .text('Página ' + (i + 1) + ' de ' + range.count, M, yr, { width: W, align: 'right', lineBreak: false });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

function nomeArquivo(para) {
  const slug = String(para || 'lista').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lista';
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return 'lista-de-precos-' + slug + '-' + d + '.pdf';
}

module.exports = { gerarListaPrecos, nomeArquivo };
