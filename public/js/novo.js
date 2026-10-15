// Tela "Novo envio": upload, deteccao de paginas, escolha de item, quantidade e totais.
(function () {
  var ITENS = window.ITENS || [];
  var rows = []; // { arquivoId, nome, paginas, quantidade, itemId }

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
  function upload(fileList) {
    if (!fileList || fileList.length === 0) return;
    if (ITENS.length === 0) { showUploadMsg('Cadastre itens antes de subir etiquetas.'); return; }
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
          rows.push({ arquivoId: a.id, nome: a.nome, paginas: a.paginas, quantidade: a.paginas, itemId: defaultItemId() });
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
          return '<option value="' + it.id + '"' + sel + '>' + escapeHtml(it.nome) + ' - ' + brl(it.preco_centavos) + '</option>';
        }).join('');
        html +=
          '<div class="file-item">' +
            '<div class="file-head">' +
              '<div class="file-ico">PDF</div>' +
              '<div><div style="font-size:13.5px;font-weight:500">' + escapeHtml(row.nome) + '</div>' +
              '<div class="dim" style="font-size:11.5px">' + row.paginas + ' páginas detectadas <span class="badge neutral" style="margin-left:6px">= ' + row.paginas + ' etiquetas</span></div></div>' +
            '</div>' +
            '<div class="file-controls">' +
              '<div><span class="lbl">Item (preço negociado)</span>' +
                '<select data-idx="' + idx + '" class="sel-item">' + opts + '</select></div>' +
              '<div><span class="lbl">Quantidade</span>' +
                '<div class="stepper"><button type="button" class="dec" data-idx="' + idx + '">&minus;</button>' +
                '<input class="qty" data-idx="' + idx + '" value="' + row.quantidade + '" inputmode="numeric" />' +
                '<button type="button" class="inc" data-idx="' + idx + '">+</button></div></div>' +
              '<div><span class="lbl">Valor unit.</span><div style="padding:8px 0;font-size:13.5px">' + brl(item.preco_centavos) + '</div></div>' +
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
      el.addEventListener('change', function () { rows[+el.dataset.idx].itemId = parseInt(el.value, 10); render(); });
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
    revisarBtn.disabled = rows.length === 0;
  }

  // ---------- revisar / aceitar ----------
  function abrirRevisar() {
    var body = document.getElementById('reviewBody');
    var html = '';
    rows.forEach(function (r) {
      var item = itemById(r.itemId) || { nome: '-', preco_centavos: 0 };
      html += '<tr><td>' + escapeHtml(r.nome) + '</td><td>' + escapeHtml(item.nome) + '</td>' +
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
      itens: rows.map(function (r) { return { arquivoId: r.arquivoId, itemId: r.itemId, quantidade: r.quantidade }; }),
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
