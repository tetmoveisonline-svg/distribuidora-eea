// Tela "Novo envio": upload, deteccao de paginas, escolha de item, quantidade e totais.
(function () {
  var ITENS = window.ITENS || [];
  var rows = []; // { arquivoId, nome, paginas, quantidade, itemId, corId }

  function corById(item, id) {
    if (!item || !item.cores) return null;
    for (var i = 0; i < item.cores.length; i++) { if (item.cores[i].id === id) return item.cores[i]; }
    return null;
  }
  // Linha com produto que tem cores e nenhuma escolhida.
  function faltaCor(row) {
    var item = itemById(row.itemId);
    return !!(item && item.cores && item.cores.length > 0 && !corById(item, row.corId));
  }
  function rotuloItem(row) {
    var item = itemById(row.itemId) || { nome: '-' };
    var cor = corById(item, row.corId);
    return item.nome + (cor ? ' · ' + cor.nome + (cor.sku ? ' (' + cor.sku + ')' : '') : (item.sku ? ' (' + item.sku + ')' : ''));
  }

  var dropzone = document.getElementById('dropzone');
  var fileInput = document.getElementById('fileInput');
  var filesBox = document.getElementById('files');
  var emptyEl = document.getElementById('empty');
  var uploadMsg = document.getElementById('uploadMsg');
  var revisarBtn = document.getElementById('revisarBtn');
  var overlay = document.getElementById('overlay');

  function brl(c) {
    return 'R$ ' + (Number(c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function itemById(id) {
    for (var i = 0; i < ITENS.length; i++) { if (ITENS[i].id === id) return ITENS[i]; }
    return null;
  }
  function defaultItemId() { return ITENS.length ? ITENS[0].id : null; }

  function showUploadMsg(txt) {
    if (!txt) { uploadMsg.style.display = 'none'; return; }
    uploadMsg.textContent = txt; uploadMsg.style.display = 'block';
  }
  var lendoMsg = document.getElementById('lendoMsg');
  function showLendo(txt) {
    if (!lendoMsg) return;
    if (!txt) { lendoMsg.style.display = 'none'; return; }
    lendoMsg.textContent = txt; lendoMsg.style.display = 'block';
  }

  // Le os codigos das etiquetas (BR... e chave da nota) de cada PDF, no navegador.
  // Retorna um array alinhado a fileList: cada item e um array de {br,nfe} por pagina.
  // Se o leitor nao estiver disponivel ou falhar, devolve null para aquele arquivo (o upload segue).
  function lerCodigos(fileList) {
    var leitor = window.LeitorEtiquetas;
    if (!leitor || typeof leitor.lerArquivo !== 'function') {
      return Promise.resolve(fileList.length ? new Array(fileList.length).fill(null) : []);
    }
    var files = Array.prototype.slice.call(fileList);
    var out = [];
    var total = files.length;
    function um(idx) {
      if (idx >= files.length) { showLendo(''); return Promise.resolve(out); }
      var f = files[idx];
      showLendo('Lendo os códigos das etiquetas... arquivo ' + (idx + 1) + ' de ' + total);
      return leitor.lerArquivo(f, function (pag, tot) {
        showLendo('Lendo os códigos das etiquetas... arquivo ' + (idx + 1) + ' de ' + total + ' (página ' + pag + '/' + tot + ')');
      }).then(function (paginas) {
        out.push(paginas || null);
        return um(idx + 1);
      }).catch(function () { out.push(null); return um(idx + 1); });
    }
    return um(0);
  }

  // ---------- upload ----------
  function upload(fileListOrig) {
    if (!fileListOrig || fileListOrig.length === 0) return;
    if (ITENS.length === 0) { showUploadMsg('Cadastre itens antes de subir etiquetas.'); return; }
    // Copia a FileList: o input e limpo logo apos o change (fileInput.value = ''), e a leitura
    // dos codigos e assincrona. Sem a copia, o FormData seria montado com a lista ja vazia.
    var fileList = Array.prototype.slice.call(fileListOrig);
    showUploadMsg('');
    dropzone.classList.add('drag');
    lerCodigos(fileList).then(function (codigosPorArquivo) {
      var fd = new FormData();
      for (var i = 0; i < fileList.length; i++) {
        fd.append('arquivos', fileList[i]);
        fd.append('codigos', JSON.stringify((codigosPorArquivo && codigosPorArquivo[i]) || []));
      }
      return fetch('/api/upload', { method: 'POST', body: fd });
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        dropzone.classList.remove('drag'); showLendo('');
        if (!res.ok) { showUploadMsg(res.j.erro || 'Falha no upload.'); return; }
        res.j.arquivos.forEach(function (a) {
          rows.push({ arquivoId: a.id, nome: a.nome, paginas: a.paginas, quantidade: a.paginas, itemId: defaultItemId(), corId: null });
        });
        render();
      })
      .catch(function () { dropzone.classList.remove('drag'); showLendo(''); showUploadMsg('Falha de conexao no upload.'); });
  }

  // ---------- render ----------
  function render() {
    if (rows.length === 0) {
      filesBox.innerHTML = '';
      emptyEl.style.display = 'block';
    } else {
      emptyEl.style.display = 'none';
      var html = '';
      rows.forEach(function (row, idx) {
        var item = itemById(row.itemId) || { preco_centavos: 0 };
        var totalLinha = item.preco_centavos * row.quantidade;
        var opts = ITENS.map(function (it) {
          var sel = it.id === row.itemId ? ' selected' : '';
          var promo = it.promo ? ' (' + escapeHtml(it.promo_rotulo) + ', de ' + brl(it.preco_original) + ')' : '';
          return '<option value="' + it.id + '"' + sel + '>' + escapeHtml(it.nome) + ' - ' + brl(it.preco_centavos) + promo + '</option>';
        }).join('');
        html +=
          '<div class="file-item">' +
            '<div class="file-head">' +
              '<div class="file-ico">PDF</div>' +
              '<div><div style="font-size:13.5px;font-weight:500">' + escapeHtml(row.nome) + '</div>' +
              '<div class="dim" style="font-size:11.5px">' + row.paginas + ' páginas detectadas <span class="badge neutral" style="margin-left:6px">= ' + row.paginas + ' etiquetas</span>' +
                (row.quantidade < row.paginas ? ' <span class="badge warn" style="margin-left:6px">vão as páginas 1 a ' + row.quantidade + '; ' + (row.paginas - row.quantidade) + ' ficam de fora</span>' : '') + '</div></div>' +
            '</div>' +
            '<div class="file-controls">' +
              '<div><span class="lbl">Item (preço negociado)</span>' +
                '<select data-idx="' + idx + '" class="sel-item">' + opts + '</select></div>' +
              (item.cores && item.cores.length ? (function () {
                var falta = faltaCor(row);
                var copts = '<option value="">— escolha a cor —</option>' + item.cores.map(function (c) {
                  return '<option value="' + c.id + '"' + (c.id === row.corId ? ' selected' : '') + '>' + escapeHtml(c.nome) + (c.sku ? ' · ' + escapeHtml(c.sku) : '') + ' · ' + c.saldo + ' disponíveis</option>';
                }).join('');
                var corSel = corById(item, row.corId);
                var avisoEst = (corSel && row.quantidade > corSel.saldo) ? '<div class="cor-hint" style="color:var(--warn)">Disponível: ' + corSel.saldo + '. Passa em ' + (row.quantidade - corSel.saldo) + '; a distribuidora confirma a reposição.</div>' : '';
                return '<div><span class="lbl">Cor</span><select data-idx="' + idx + '" class="sel-cor cor-sel' + (falta ? ' missing' : '') + '">' + copts + '</select>' +
                  (falta ? '<div class="cor-hint">Informe a cor para revisar</div>' : avisoEst) + '</div>';
              })() : ((item.saldo !== null && item.saldo !== undefined && row.quantidade > item.saldo)
                ? '<div><span class="lbl">Estoque</span><div class="cor-hint" style="color:var(--warn);padding:8px 0">' + item.saldo + ' disponíveis; passa em ' + (row.quantidade - item.saldo) + '.</div></div>' : '')) +
              '<div><span class="lbl">Quantidade</span>' +
                '<div class="stepper"><button type="button" class="dec" data-idx="' + idx + '">&minus;</button>' +
                '<input class="qty" data-idx="' + idx + '" value="' + row.quantidade + '" inputmode="numeric" />' +
                '<button type="button" class="inc" data-idx="' + idx + '">+</button></div></div>' +
              '<div><span class="lbl">Valor unit.</span><div style="padding:8px 0;font-size:13.5px">' + brl(item.preco_centavos) +
                (item.promo ? ' <span class="badge ok" style="margin-left:4px">' + escapeHtml(item.promo_rotulo) + '</span>' : '') + '</div></div>' +
              '<div><span class="lbl">Total</span><div style="padding:8px 0;font-size:14px;font-weight:600">' + brl(totalLinha) + '</div></div>' +
              '<div><span class="lbl">&nbsp;</span><button type="button" class="file-remove" data-idx="' + idx + '">remover</button></div>' +
            '</div>' +
          '</div>';
      });
      filesBox.innerHTML = html;
      bind();
    }
    updateTotals();
  }

  function bind() {
    filesBox.querySelectorAll('.sel-item').forEach(function (el) {
      el.addEventListener('change', function () { var r = rows[+el.dataset.idx]; r.itemId = parseInt(el.value, 10); r.corId = null; render(); });
    });
    filesBox.querySelectorAll('.sel-cor').forEach(function (el) {
      el.addEventListener('change', function () { rows[+el.dataset.idx].corId = el.value ? parseInt(el.value, 10) : null; render(); });
    });
    filesBox.querySelectorAll('.inc').forEach(function (el) {
      el.addEventListener('click', function () { var i = +el.dataset.idx; rows[i].quantidade++; render(); });
    });
    filesBox.querySelectorAll('.dec').forEach(function (el) {
      el.addEventListener('click', function () { var i = +el.dataset.idx; if (rows[i].quantidade > 1) rows[i].quantidade--; render(); });
    });
    filesBox.querySelectorAll('.qty').forEach(function (el) {
      el.addEventListener('change', function () {
        var i = +el.dataset.idx; var v = parseInt(el.value, 10);
        rows[i].quantidade = (!v || v < 1) ? 1 : v; render();
      });
    });
    filesBox.querySelectorAll('.file-remove').forEach(function (el) {
      el.addEventListener('click', function () { rows.splice(+el.dataset.idx, 1); render(); });
    });
  }

  function totals() {
    var totalC = 0, labels = 0;
    rows.forEach(function (r) {
      var item = itemById(r.itemId) || { preco_centavos: 0 };
      totalC += item.preco_centavos * r.quantidade;
      labels += r.quantidade;
    });
    return { totalC: totalC, labels: labels };
  }

  function updateTotals() {
    var t = totals();
    document.getElementById('fileCount').textContent = rows.length;
    document.getElementById('labelCount').textContent = t.labels;
    document.getElementById('grandTotal').textContent = brl(t.totalC);
    var excede = verificarCredito(t.totalC);
    var semCor = rows.some(faltaCor);
    revisarBtn.disabled = rows.length === 0 || excede || semCor;
    revisarBtn.title = semCor ? 'Escolha a cor de cada arquivo para revisar' : '';
  }

  // ---------- limite de credito ----------
  // CREDITO vem do servidor: { controlado, disponivel, limite, aberto, bloqueado, proximo, maisVencido }.
  // Se o total passar do disponivel, mostra o aviso com a quantidade que ainda cabe do item que estourou.
  var CREDITO = window.CREDITO || null;
  var creditWarn = document.getElementById('creditWarn');
  var revisarHint = document.getElementById('revisarHint');
  var linhaSugerida = null; // { idx, qtd }

  function verificarCredito(totalC) {
    if (!CREDITO || !CREDITO.controlado || rows.length === 0) { esconderAviso(); return !!(CREDITO && CREDITO.bloqueado && rows.length); }
    if (CREDITO.bloqueado) { esconderAviso(); return true; }
    if (totalC <= CREDITO.disponivel) { esconderAviso(); return false; }

    var excesso = totalC - CREDITO.disponivel;
    document.getElementById('cwText').textContent =
      'O pedido fica em ' + brl(totalC) + ' e você tem ' + brl(CREDITO.disponivel) + ' de crédito disponível. Excede em ' + brl(excesso) + '.';

    // Sugestao: reduz a ultima linha (a que fez estourar) ate caber. Se nem zerando ela cabe, avisa.
    var idx = rows.length - 1;
    var row = rows[idx];
    var item = itemById(row.itemId) || { preco_centavos: 0, nome: '-' };
    var outros = totalC - item.preco_centavos * row.quantidade;
    var sobra = CREDITO.disponivel - outros;
    var cabe = item.preco_centavos > 0 ? Math.floor(sobra / item.preco_centavos) : 0;
    var sug = document.getElementById('cwSugestao');
    var btn = document.getElementById('cwAjustar');
    if (cabe >= 1 && cabe < row.quantidade) {
      sug.textContent = 'Com o crédito atual cabem até ' + cabe + ' etiqueta' + (cabe > 1 ? 's' : '') + ' de ' + item.nome +
        ' (' + brl(cabe * item.preco_centavos) + ') neste arquivo. Valem sempre as primeiras: o pedido fica com as páginas 1 a ' + cabe +
        ' do PDF, e as outras ' + (row.quantidade - cabe) + ' (páginas ' + (cabe + 1) + ' a ' + row.quantidade + ') ficam de fora, para um próximo envio.';
      btn.textContent = 'Ajustar para ' + cabe + ' etiqueta' + (cabe > 1 ? 's' : '');
      btn.style.display = 'inline-block';
      linhaSugerida = { idx: idx, qtd: cabe };
    } else {
      sug.textContent = rows.length > 1
        ? 'Mesmo sem este arquivo o restante já passa do crédito. Remova arquivos ou reduza as quantidades até o total caber em ' + brl(CREDITO.disponivel) + '.'
        : 'Nenhuma etiqueta de ' + item.nome + ' cabe no crédito disponível agora.';
      btn.style.display = 'none';
      linhaSugerida = null;
    }

    var saldo = document.getElementById('cwSaldo');
    saldo.textContent = CREDITO.proximo
      ? 'Antecipe o pagamento do pedido ' + CREDITO.proximo.numero + ' (' + brl(CREDITO.proximo.valor) + ', vence ' + CREDITO.proximo.vencimento + ') e o crédito volta assim que a distribuidora der baixa. Ou fale com a empresa para ampliar o limite.'
      : 'Fale com a empresa para ampliar o limite de crédito.';
    atualizarWhats(totalC, excesso, item, row.quantidade);

    creditWarn.style.display = 'block';
    if (revisarHint) revisarHint.style.display = 'block';
    return true;
  }
  function esconderAviso() {
    creditWarn.style.display = 'none';
    if (revisarHint) revisarHint.style.display = 'none';
    linhaSugerida = null;
  }
  // ---------- WhatsApp: mensagem padrao de antecipacao de pagamento ----------
  var WHATSAPP = window.WHATSAPP || '';
  var CLIENTE = window.CLIENTE || { nome: '', login: '' };
  function linhaPedido(p) {
    return '• Pedido em aberto: *' + p.numero + '* – ' + brl(p.valor) + (p.vencido ? ' (venceu ' : ' (vence ') + p.vencimento + ')';
  }
  function mensagemWhats(totalC, excesso, item, qtd) {
    var l = [];
    l.push('Olá! Sou da *' + CLIENTE.nome + '*' + (CLIENTE.login ? ' (login ' + CLIENTE.login + ')' : '') + '.');
    l.push('Quero antecipar o pagamento para liberar mais crédito na plataforma.');
    l.push('');
    (CREDITO && CREDITO.abertos || []).forEach(function (p) { l.push(linhaPedido(p)); });
    if (CREDITO && CREDITO.controlado) l.push('• Crédito disponível hoje: ' + brl(CREDITO.disponivel));
    if (totalC) l.push('• Envio que preciso fazer: ' + brl(totalC) + (item ? ' (' + qtd + ' etiqueta' + (qtd > 1 ? 's' : '') + ' de ' + item.nome + ')' : ''));
    if (excesso) l.push('• Preciso liberar: *' + brl(excesso) + '*');
    l.push('');
    l.push('Podem me passar a chave Pix ou o boleto para antecipar?');
    return l.join('\n');
  }
  function linkWhats(msg) { return 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(msg); }
  function atualizarWhats(totalC, excesso, item, qtd) {
    var a = document.getElementById('cwWhats');
    if (!a || !WHATSAPP) return;
    a.href = linkWhats(mensagemWhats(totalC, excesso, item, qtd));
  }
  // Bloqueio por vencido: o link ja fica pronto ao abrir a pagina (sem envio em andamento).
  (function () {
    var b = document.getElementById('bloqWhats');
    if (b && WHATSAPP) b.href = linkWhats(mensagemWhats(0, 0, null, 0));
  })();

  document.getElementById('cwAjustar').addEventListener('click', function () {
    if (!linhaSugerida || !rows[linhaSugerida.idx]) return;
    rows[linhaSugerida.idx].quantidade = linhaSugerida.qtd;
    render();
  });

  // ---------- revisar / aceitar ----------
  function abrirRevisar() {
    var body = document.getElementById('reviewBody');
    var html = '';
    rows.forEach(function (r) {
      var item = itemById(r.itemId) || { nome: '-', preco_centavos: 0 };
      html += '<tr><td>' + escapeHtml(r.nome) + '</td><td>' + escapeHtml(rotuloItem(r)) + '</td>' +
        '<td class="num">' + r.quantidade + '</td><td class="num">' + brl(item.preco_centavos) + '</td>' +
        '<td class="num">' + brl(item.preco_centavos * r.quantidade) + '</td></tr>';
    });
    body.innerHTML = html;
    var t = totals();
    document.getElementById('reviewLabels').textContent = t.labels;
    document.getElementById('reviewTotal').textContent = brl(t.totalC);
    document.getElementById('confirmCk').checked = false;
    document.getElementById('acceptBtn').disabled = true;
    document.getElementById('acceptMsg').style.display = 'none';
    overlay.classList.add('on');
  }
  function fecharRevisar() { overlay.classList.remove('on'); }

  function aceitar() {
    var btn = document.getElementById('acceptBtn');
    btn.disabled = true; btn.textContent = 'Gerando...';
    var payload = {
      aceite: true,
      observacoes: document.getElementById('obs').value || '',
      itens: rows.map(function (r) { return { arquivoId: r.arquivoId, itemId: r.itemId, corId: r.corId, quantidade: r.quantidade }; }),
    };
    fetch('/api/pedidos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          var m = document.getElementById('acceptMsg'); m.textContent = res.j.erro || 'Falha ao gerar o pedido.'; m.style.display = 'block';
          btn.textContent = 'Aceitar e gerar PDF'; btn.disabled = false; return;
        }
        window.location.href = '/meus-envios';
      })
      .catch(function () {
        var m = document.getElementById('acceptMsg'); m.textContent = 'Falha de conexao.'; m.style.display = 'block';
        btn.textContent = 'Aceitar e gerar PDF'; btn.disabled = false;
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- eventos base ----------
  dropzone.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { upload(fileInput.files); fileInput.value = ''; });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('drag'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) upload(e.dataTransfer.files);
  });

  revisarBtn.addEventListener('click', abrirRevisar);
  document.getElementById('voltarBtn').addEventListener('click', fecharRevisar);
  document.getElementById('confirmCk').addEventListener('change', function () {
    document.getElementById('acceptBtn').disabled = !this.checked;
  });
  document.getElementById('acceptBtn').addEventListener('click', aceitar);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) fecharRevisar(); });

  render();
})();
