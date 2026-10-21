/* Tela do Dimensionador: le o formulario, recalcula a cada alteracao e desenha a previa do PDF. */
(function () {
  'use strict';
  var CFG = window.DIM_CONFIG, C = window.DimCalc;
  var $ = function (id) { return document.getElementById(id); };
  var fmtInt = function (n) { return Math.round(n).toLocaleString('pt-BR'); };
  var fmt1 = function (n) { return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); };
  var brl = function (n) { return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var rot = { capa: { sim: 'com capa', nao: 'sem capa' }, tipo: { aberta: 'aberta', fechada: 'fechada' }, vento: { fraco: 'fraco', moderado: 'moderado', forte: 'forte' } };

  var modoVolume = 'medidas', escolhaIdx = 0, opcoes = [];

  Object.keys(CFG.clima).sort().forEach(function (uf) { var o = document.createElement('option'); o.value = uf; o.textContent = uf; $('uf').appendChild(o); });
  $('uf').value = 'MG';

  function ler() {
    return {
      modoVolume: modoVolume, litros: $('litros').value,
      principal: { comprimento: $('pComp').value, largura: $('pLarg').value, profundidade: $('pProf').value },
      temPrainha: $('temPrainha').checked, prainha: { comprimento: $('prComp').value, largura: $('prLarg').value, profundidade: $('prProf').value },
      tempInicial: $('tIni').value, tempDesejada: $('tDes').value, tarifa: $('tarifa').value,
      capa: $('capa').value, tipo: $('tipo').value, vento: $('vento').value,
      temCascata: $('temCascata').checked, cascataCm: $('cascataCm').value,
      temInfinita: $('temInfinita').checked, infinita: { comprimento: '', largura: '', profundidade: '' }, infinitaBordaM: $('inBorda').value,
      horasRecirculacao: $('hRec').value, mca: $('mca').value,
    };
  }
  function cliente() {
    return { nome: $('cliente').value.trim(), cidade: $('cidade').value.trim(), uf: $('uf').value, fone: $('fone').value.trim(), numero: $('numero').value.trim() };
  }

  function recalcular() {
    var f = ler(), c = C.cargaTermica(CFG, f);
    $('volPreview').textContent = 'Volume considerado: ' + fmtInt(c.volumeLitros) + ' litros.';
    var valido = c.volumeLitros >= 1000 && C.num(f.tempDesejada) > C.num(f.tempInicial);
    if (!valido) { $('opcoes').innerHTML = '<p class="hint">Preencha volume e temperaturas para ver as opções.</p>'; $('page').innerHTML = ''; $('status').textContent = 'Dados incompletos'; return; }
    opcoes = C.opcoes(CFG, f);
    if (!opcoes.length) opcoes = [C.selecionar(CFG, f)];
    if (escolhaIdx >= opcoes.length) escolhaIdx = 0;
    $('opcoes').innerHTML = opcoes.map(function (o, i) {
      return '<button type="button" class="opt' + (i === escolhaIdx ? ' on' : '') + '" data-i="' + i + '"><div><strong>' + o.quantidade + ' × ' + esc(o.modelo.nome) + '</strong>' +
        '<small>' + fmtInt(o.totalBtu) + ' BTU/h · ' + fmt1(o.horasDia) + ' h/dia · primeiro aquecimento ' + fmt1(o.horasPrimeiroAquecimento) + ' h · ' + fmt1(o.kwMax) + ' kW</small></div>' +
        '<span class="tag' + (o.recomendado ? '' : ' line') + '">' + (i === 0 ? 'Automática' : esc(o.modelo.linha)) + '</span></button>';
    }).join('');
    document.querySelectorAll('.opt').forEach(function (b) { b.addEventListener('click', function () { escolhaIdx = Number(b.dataset.i); recalcular(); }); });
    desenharDocumento(f, opcoes[escolhaIdx]);
    $('status').textContent = 'Atualizado ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function desenharDocumento(f, s) {
    var cl = cliente(), c = s.carga, p = C.projecaoAnual(CFG, f, s, cl.uf);
    var maxKwh = Math.max.apply(null, p.meses.map(function (m) { return m.kwh; }));
    var hid = s.hidraulica;
    var h = '';
    h += '<div class="doc-head"><img class="gn" src="assets/logo-gn.png" style="filter:none;background:' + '#1f3a7a' + ';border-radius:8px;padding:4px 10px" alt="GN" />' +
      '<div class="t"><strong>Dimensionamento de bomba de calor</strong><span>Indicação preliminar para piscina · ' + esc(CFG.marca.nome) + '</span></div>' +
      '<img class="sy" src="assets/logo-syllent.png" alt="Syllent" /></div>';
    h += '<div class="doc-meta"><span>Cliente: <b>' + esc(cl.nome || '—') + '</b></span><span>Data: <b>' + new Date().toLocaleDateString('pt-BR') + '</b></span>' +
      '<span>Local: <b>' + esc((cl.cidade ? cl.cidade + ' / ' : '') + cl.uf) + '</b></span><span>Orçamento nº: <b>' + esc(cl.numero || '—') + '</b></span></div>';
    h += '<div class="doc-main"><div><div class="k">Equipamento indicado</div><div class="v">' + s.quantidade + ' × ' + esc(s.modelo.nome) + '</div><div class="s">Linha ' + esc(s.modelo.linha) + ' · ' + fmtInt(s.totalKcal) + ' kcal/h · consumo máximo ' + fmt1(s.kwMax) + ' kW</div></div>' +
      '<div class="b"><div class="k">Capacidade total</div><div class="v">' + fmtInt(s.totalBtu) + ' BTU/h</div></div></div>';
    h += '<div class="doc-kpis">' +
      kpi('Carga térmica', fmtInt(c.kcal), 'kcal', fmtInt(c.btu) + ' BTU') +
      kpi('Aquecimento diário', fmt1(s.horasDia), 'h/dia', 'critério: abaixo de ' + CFG.constantes.limiteHorasDia + ' h', s.horasDia < CFG.constantes.limiteHorasDia ? 'ok' : 'warn') +
      kpi('Primeiro aquecimento', fmt1(s.horasPrimeiroAquecimento), 'h', 'critério: abaixo de ' + CFG.constantes.limitePrimeiroAquecH + ' h', s.horasPrimeiroAquecimento < CFG.constantes.limitePrimeiroAquecH ? 'ok' : 'warn') + '</div>';
    h += '<div class="doc-h">Custo de energia estimado · ' + esc(p.referencia) + ' · tarifa R$ ' + Number(f.tarifa).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + '/kWh</div><div class="doc-chart">';
    p.meses.forEach(function (m) { h += '<div class="' + (m === p.mesPico ? 'peak' : '') + '" style="height:' + Math.max(4, m.kwh / maxKwh * 100) + '%"><span>' + brl(m.custo) + '</span><i>' + m.mes.slice(0, 3) + '</i></div>'; });
    h += '</div><div class="doc-cost"><div><div class="k">Custo anual</div><div class="v">' + brl(p.custoAno) + '</div></div><div><div class="k">Primeiro aquecimento</div><div class="v">' + brl(p.custoPrimeiroAquecimento) + '</div></div>' +
      '<div><div class="k">Mês de pico</div><div class="v">' + esc(p.mesPico.mes) + ' · ' + fmt1(p.mesPico.horasDia) + ' h/dia</div></div><div><div class="k">Consumo anual</div><div class="v">' + fmtInt(p.kwhAno) + ' kWh</div></div></div>';
    h += '<div class="doc-h">Dados considerados</div><table class="doc-tab">' +
      tr('Volume total', fmtInt(c.volumeLitros) + ' litros' + (f.modoVolume === 'medidas' ? ' (' + f.principal.comprimento + ' × ' + f.principal.largura + ' × ' + f.principal.profundidade + ' m' + (f.temPrainha ? ' + prainha' : '') + ')' : '')) +
      tr('Temperaturas', f.tempInicial + ' °C → ' + f.tempDesejada + ' °C (Δ ' + fmt1(c.deltaC) + ' °C)') +
      tr('Condição', rot.capa[f.capa] + ' · ' + rot.tipo[f.tipo] + ' · vento ' + rot.vento[f.vento] + ' (fatores ' + c.fatores.capa + ' × ' + c.fatores.tipo + ' × ' + c.fatores.vento + ')') +
      tr('Acessórios', acess(f) + (c.acessoriosKcal ? ' · +' + fmtInt(c.acessoriosKcal) + ' kcal' : '')) +
      tr('Hidráulica', 'vazão de projeto ' + fmt1(hid.vazaoNecessaria) + ' m³/h · motobomba ' + (hid.bomba ? hid.bomba.cv + ' cv (' + hid.mca + ' mca)' : 'acima da tabela')) +
      '</table>';
    h += '<div class="doc-foot"><span>' + esc(CFG.marca.nome) + ' · representante ' + esc(CFG.marca.fabricante) + '</span><span>Resultado preliminar, sem valor de projeto executivo ou garantia de desempenho.</span></div>';
    $('page').innerHTML = h;
  }
  function kpi(k, v, u, c, cls) { return '<div class="doc-kpi ' + (cls || '') + '"><div class="k">' + k + '</div><div class="v">' + v + ' <small>' + u + '</small></div><div class="c">' + c + '</div></div>'; }
  function tr(k, v) { return '<tr><th>' + k + '</th><td>' + v + '</td></tr>'; }
  function acess(f) {
    var a = [];
    if (f.temPrainha && f.modoVolume === 'medidas') a.push('prainha');
    if (f.temCascata) a.push('cascata ' + f.cascataCm + ' cm');
    if (f.temInfinita) a.push('borda infinita ' + f.infinitaBordaM + ' m');
    return a.length ? a.join(', ') : 'nenhum';
  }

  /* eventos */
  document.querySelectorAll('.seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      modoVolume = b.dataset.v;
      document.querySelectorAll('.seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('modoMedidas').hidden = modoVolume !== 'medidas'; $('modoLitros').hidden = modoVolume !== 'litros';
      recalcular();
    });
  });
  $('temPrainha').addEventListener('change', function () { $('prainhaBox').hidden = !this.checked; });
  $('temCascata').addEventListener('change', function () { $('cascataBox').hidden = !this.checked; });
  $('temInfinita').addEventListener('change', function () { $('infinitaBox').hidden = !this.checked; });
  document.querySelectorAll('input, select').forEach(function (el) { el.addEventListener('input', recalcular); el.addEventListener('change', recalcular); });
  $('btnLimpar').addEventListener('click', function () { ['cliente', 'cidade', 'fone'].forEach(function (id) { $(id).value = ''; }); recalcular(); });

  /* PDF: no Electron, a ponte window.dim.gerarPdf() salva o arquivo; no navegador cai na impressao. */
  $('btnPdf').addEventListener('click', function () {
    var cl = cliente();
    var nome = 'Dimensionamento - ' + (cl.nome || 'cliente').replace(/[\/:*?"<>|]/g, '').trim() + ' - ' + new Date().toISOString().slice(0, 10) + '.pdf';
    if (!(window.dim && window.dim.gerarPdf)) { var t = document.title; document.title = nome.replace(/.pdf$/, ''); window.print(); document.title = t; return; }
    $('status').textContent = 'Gerando PDF…';
    window.dim.gerarPdf({ nome: nome, html: $('page').innerHTML, formulario: { f: ler(), cliente: cl } }).then(function (r) {
      if (r && r.ok) {
        $('status').textContent = 'PDF salvo em ' + r.caminho;
        ultimoPdf = r.caminho; $('btnAbrirPdf').hidden = false;
        proximoNumero();
      } else { $('status').textContent = r && r.cancelado ? 'Salvamento cancelado' : 'Falha ao gerar PDF'; }
    });
  });
  $('btnPasta').addEventListener('click', function () { if (window.dim && window.dim.abrirPasta) window.dim.abrirPasta(); });
  $('btnAbrirPdf').addEventListener('click', function () { if (ultimoPdf && window.dim) window.dim.abrirPdf(ultimoPdf); });
  $('pasta').addEventListener('click', function () { if (window.dim && window.dim.escolherPasta) window.dim.escolherPasta().then(function (p) { $('pasta').textContent = p; }); });

  var ultimoPdf = null;
  function numeroAno(n) { return new Date().getFullYear() + '-' + String(n).padStart(4, '0'); }
  function proximoNumero() { if (window.dim) window.dim.lerConfig().then(function (c) { $('numero').value = numeroAno(c.proximoNumero || 1); }); }
  function carregarConfig() {
    if (!(window.dim && window.dim.lerConfig)) return;
    window.dim.lerConfig().then(function (c) {
      $('pasta').textContent = c.pasta; $('pasta').title = 'Clique para trocar a pasta';
      $('numero').value = numeroAno(c.proximoNumero || 1);
      var u = c.ultimo && c.ultimo.f;
      if (u) {
        modoVolume = u.modoVolume || 'medidas';
        document.querySelectorAll('.seg button').forEach(function (x) { x.classList.toggle('on', x.dataset.v === modoVolume); });
        $('modoMedidas').hidden = modoVolume !== 'medidas'; $('modoLitros').hidden = modoVolume !== 'litros';
        $('litros').value = u.litros; $('pComp').value = u.principal.comprimento; $('pLarg').value = u.principal.largura; $('pProf').value = u.principal.profundidade;
        $('tIni').value = u.tempInicial; $('tDes').value = u.tempDesejada; $('tarifa').value = u.tarifa;
        $('capa').value = u.capa; $('tipo').value = u.tipo; $('vento').value = u.vento; $('hRec').value = u.horasRecirculacao; $('mca').value = u.mca;
        if (c.ultimo.cliente && c.ultimo.cliente.uf) $('uf').value = c.ultimo.cliente.uf;
      }
      recalcular();
    });
  }
  carregarConfig();
  if (!window.dim) { $('pasta').hidden = true; $('btnPasta').hidden = true; $('btnPdf').textContent = 'Salvar PDF'; document.querySelector('.preview-bar span').textContent = 'Prévia do PDF · A4 · 1 página · no Mac, escolha "Salvar como PDF" na janela de impressão'; }

  recalcular();
})();
