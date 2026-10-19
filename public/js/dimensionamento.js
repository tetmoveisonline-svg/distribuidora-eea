/* Interface do Dimensionador: wizard de 3 etapas + resultado + WhatsApp. O calculo fica em dimensionamento-calc.js. */
(function () {
  'use strict';
  var CFG = window.DIM_CONFIG, C = window.DimCalc;
  var $ = function (id) { return document.getElementById(id); };
  var UFS = Object.keys(CFG.clima).sort();

  var form = {
    modoVolume: 'litros', litros: '50000',
    principal: { comprimento: '8', largura: '4', profundidade: '1.4' },
    temPrainha: false, prainha: { comprimento: '', largura: '', profundidade: '0.3' },
    tempInicial: '20', tempDesejada: '32', tarifa: '1.00',
    capa: 'sim', tipo: 'aberta', vento: 'moderado',
    temCascata: false, cascataCm: '',
    temInfinita: false, infinita: { comprimento: '', largura: '', profundidade: '0.3' }, infinitaBordaM: '',
    horasRecirculacao: '8', mca: '8',
  };
  var contato = { perfil: 'Revenda', nome: '', empresa: '', uf: '', cidade: '', whatsapp: '', consent: false };
  var etapa = 1, escolha = null, opcoesAtuais = [];

  /* ---------- utilidades ---------- */
  var fmtInt = function (n) { return Math.round(n).toLocaleString('pt-BR'); };
  var fmt1 = function (n) { return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); };
  var brl = function (n) { return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var rotulo = { capa: { sim: 'com capa', nao: 'sem capa' }, tipo: { aberta: 'aberta', fechada: 'fechada' }, vento: { fraco: 'fraco', moderado: 'moderado', forte: 'forte' } };

  function lerCampos() {
    form.litros = $('litros').value;
    form.principal = { comprimento: $('pComp').value, largura: $('pLarg').value, profundidade: $('pProf').value };
    form.temPrainha = $('temPrainha').checked;
    form.prainha = { comprimento: $('prComp').value, largura: $('prLarg').value, profundidade: $('prProf').value };
    form.tempInicial = $('tIni').value; form.tempDesejada = $('tDes').value; form.tarifa = $('tarifa').value;
    form.temCascata = $('temCascata').checked; form.cascataCm = $('cascataCm').value;
    form.temInfinita = $('temInfinita').checked;
    form.infinita = { comprimento: $('inComp').value, largura: $('inLarg').value, profundidade: $('inProf').value };
    form.infinitaBordaM = $('inBorda').value;
    form.horasRecirculacao = $('hRec').value; form.mca = $('mca').value;
    contato.nome = $('nome').value.trim(); contato.empresa = $('empresa').value.trim();
    contato.uf = $('uf').value; contato.cidade = $('cidade').value.trim();
    contato.whatsapp = $('zap').value.trim(); contato.consent = $('consent').checked;
  }

  function mostrarEtapa(n) {
    etapa = n;
    [1, 2, 3, 4].forEach(function (i) { $('step' + i).hidden = i !== n; });
    var titulos = { 1: 'Piscina', 2: 'Condições de uso', 3: 'Seu contato profissional', 4: 'Resultado' };
    $('stepLabel').textContent = n === 4 ? 'Relatório técnico preliminar' : 'Etapa ' + n + ' de 3';
    $('stepTitle').textContent = titulos[n];
    $('bar').style.width = (n === 4 ? 100 : n * 33) + '%';
    document.querySelectorAll('#steps li').forEach(function (li) {
      var s = Number(li.dataset.step);
      li.classList.toggle('on', s === n); li.classList.toggle('done', s < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function erro(id, msg) { var el = $(id); el.textContent = msg || ''; el.hidden = !msg; }

  /* ---------- etapa 1 ---------- */
  document.querySelectorAll('[data-modo]').forEach(function (b) {
    b.addEventListener('click', function () {
      form.modoVolume = b.dataset.modo;
      document.querySelectorAll('[data-modo]').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('modoLitros').hidden = form.modoVolume !== 'litros';
      $('modoMedidas').hidden = form.modoVolume !== 'medidas';
      previewVolume();
    });
  });
  $('temPrainha').addEventListener('change', function () { $('prainhaBox').hidden = !this.checked; previewVolume(); });
  ['pComp', 'pLarg', 'pProf', 'prComp', 'prLarg', 'prProf'].forEach(function (id) { $(id).addEventListener('input', previewVolume); });
  function previewVolume() {
    lerCampos();
    var v = C.volumeM3(form.principal) + (form.temPrainha ? C.volumeM3(form.prainha) : 0);
    $('volPreview').textContent = v > 0 ? 'Total atual: ' + fmtInt(v * 1000) + ' litros.' : '';
  }

  $('step1').addEventListener('submit', function (e) {
    e.preventDefault(); lerCampos();
    var c = C.cargaTermica(CFG, form);
    if (!(c.volumeLitros >= 1000)) return erro('err1', 'Informe um volume válido (mínimo 1.000 litros).');
    erro('err1'); mostrarEtapa(2);
  });

  /* ---------- etapa 2 ---------- */
  document.querySelectorAll('.dim-seg[data-campo] button, .dim-profiles[data-campo] button').forEach(function (b) {
    b.addEventListener('click', function () {
      var grupo = b.parentElement, campo = grupo.dataset.campo;
      grupo.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      if (campo === 'perfil') contato.perfil = b.dataset.v; else form[campo] = b.dataset.v;
    });
  });
  $('temCascata').addEventListener('change', function () { $('cascataBox').hidden = !this.checked; });
  $('temInfinita').addEventListener('change', function () { $('infinitaBox').hidden = !this.checked; });

  $('step2').addEventListener('submit', function (e) {
    e.preventDefault(); lerCampos();
    var ti = C.num(form.tempInicial), td = C.num(form.tempDesejada);
    if (!(td > ti)) return erro('err2', 'A temperatura desejada precisa ser maior que a inicial.');
    if (!(C.num(form.tarifa) > 0)) return erro('err2', 'Informe a tarifa de energia em R$/kWh.');
    if (form.temCascata && !(C.num(form.cascataCm) > 0)) return erro('err2', 'Informe o comprimento da cascata.');
    if (form.temInfinita && !(C.area(form.infinita) > 0 || C.num(form.infinitaBordaM) > 0)) return erro('err2', 'Informe a área ou os metros de borda infinita.');
    erro('err2'); mostrarEtapa(3);
  });

  /* ---------- etapa 3 ---------- */
  UFS.forEach(function (uf) { var o = document.createElement('option'); o.value = uf; o.textContent = uf; $('uf').appendChild(o); });
  $('zap').addEventListener('input', function () {
    var d = this.value.replace(/\D/g, '').slice(0, 11);
    this.value = d.length > 6 ? '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7) : d.length > 2 ? '(' + d.slice(0, 2) + ') ' + d.slice(2) : d;
  });
  document.querySelectorAll('[data-back]').forEach(function (b) { b.addEventListener('click', function () { mostrarEtapa(etapa - 1); }); });

  $('step3').addEventListener('submit', function (e) {
    e.preventDefault(); lerCampos();
    if (!contato.nome) return erro('err3', 'Informe seu nome.');
    if (!contato.uf) return erro('err3', 'Selecione a UF do projeto.');
    if (contato.whatsapp.replace(/\D/g, '').length < 10) return erro('err3', 'Informe um WhatsApp válido com DDD.');
    if (!contato.consent) return erro('err3', 'É preciso autorizar o uso dos dados para receber o resultado.');
    erro('err3');
    opcoesAtuais = C.opcoes(CFG, form);
    escolha = opcoesAtuais[0] || C.selecionar(CFG, form);
    renderResultado(); mostrarEtapa(4);
  });

  /* ---------- resultado ---------- */
  function renderResultado() {
    var s = escolha, c = s.carga, p = C.projecaoAnual(CFG, form, s, contato.uf);
    var maxKwh = Math.max.apply(null, p.meses.map(function (m) { return m.kwh; }));
    var h = '';
    h += '<div class="r-head"><div><p class="dim-eyebrow">Equipamento indicado</p><h3>' + s.quantidade + ' × ' + esc(s.modelo.nome) + '</h3></div>' +
      '<span class="r-badge' + (s.recomendado ? '' : ' warn') + '">' + (s.recomendado ? 'Atende aos critérios' : 'Fora dos limites · validar') + '</span></div>';
    h += '<div class="r-main"><div class="k">Capacidade térmica total</div><div class="v">' + fmtInt(s.totalBtu) + '<small>BTU/h</small></div>' +
      '<div class="sub">' + fmtInt(s.totalKcal) + ' kcal/h · linha ' + esc(s.modelo.linha) + ' · consumo máximo ' + fmt1(s.kwMax) + ' kW</div></div>';
    h += '<div class="r-kpis">' +
      kpi('Carga calculada', fmtInt(c.kcal), 'kcal', fmtInt(c.btu) + ' BTU') +
      kpi('Aquecimento diário', fmt1(s.horasDia), 'h/dia', 'Critério: menos de ' + CFG.constantes.limiteHorasDia + ' h/dia', s.horasDia < CFG.constantes.limiteHorasDia ? 'ok' : 'warn') +
      kpi('Primeiro aquecimento', fmt1(s.horasPrimeiroAquecimento), 'h', 'Critério: menos de ' + CFG.constantes.limitePrimeiroAquecH + ' h', s.horasPrimeiroAquecimento < CFG.constantes.limitePrimeiroAquecH ? 'ok' : 'warn') +
      '</div>';

    if (opcoesAtuais.length > 1) {
      h += '<div class="r-sec"><h4>Outras configurações que atendem</h4><div class="r-opts">';
      opcoesAtuais.forEach(function (o, i) {
        h += '<button type="button" class="r-opt' + (o === escolha ? ' on' : '') + '" data-opt="' + i + '"><div><strong>' + o.quantidade + ' × ' + esc(o.modelo.nome) + '</strong>' +
          '<small>' + fmtInt(o.totalBtu) + ' BTU · ' + fmt1(o.horasDia) + ' h/dia · ' + fmt1(o.kwMax) + ' kW</small></div><span class="tag">' + esc(o.modelo.linha) + '</span></button>';
      });
      h += '</div></div>';
    }

    h += '<div class="r-sec"><h4>Energia · ' + esc(p.referencia) + '</h4><div class="r-chart-wrap"><div class="r-chart">';
    p.meses.forEach(function (m) {
      h += '<div class="' + (m === p.mesPico ? 'peak' : '') + '" style="height:' + Math.max(3, (m.kwh / maxKwh) * 100) + '%"><span>' + brl(m.custo) + '</span><i>' + m.mes.slice(0, 3) + '</i></div>';
    });
    h += '</div></div><div class="r-cost">' +
      '<div><div class="k">Custo anual estimado</div><div class="v">' + brl(p.custoAno) + '</div></div>' +
      '<div><div class="k">Primeiro aquecimento</div><div class="v">' + brl(p.custoPrimeiroAquecimento) + '</div></div>' +
      '<div><div class="k">Mês de pico</div><div class="v">' + esc(p.mesPico.mes) + ' · ' + fmt1(p.mesPico.horasDia) + ' h/dia</div></div>' +
      '<div><div class="k">Consumo anual</div><div class="v">' + fmtInt(p.kwhAno) + ' kWh</div></div></div></div>';

    var hid = s.hidraulica;
    h += '<div class="r-sec"><h4>Pré-seleção hidráulica</h4><table class="r-tab">' +
      linha('Vazão de projeto', fmt1(hid.vazaoNecessaria) + ' m³/h') +
      linha('Vazão da bomba de calor', fmt1(hid.vazaoBombaCalor) + ' m³/h') +
      linha('Renovação em ' + hid.horasRecirculacao + ' h', fmt1(hid.vazaoRenovacao) + ' m³/h') +
      linha('Motobomba indicada (' + hid.mca + ' mca)', hid.bomba ? hid.bomba.cv + ' cv · ' + fmt1(hid.vazaoDisponivel) + ' m³/h' : 'Acima da tabela · validar') +
      '</table></div>';

    h += '<div class="r-sec"><h4>Dados considerados</h4><table class="r-tab">' +
      linha('Volume total', fmtInt(c.volumeLitros) + ' litros' + (form.modoVolume === 'medidas' ? ' (pelas medidas)' : '')) +
      linha('Temperaturas', form.tempInicial + ' °C → ' + form.tempDesejada + ' °C (Δ ' + fmt1(c.deltaC) + ' °C)') +
      linha('Condição', rotulo.capa[form.capa] + ' · ' + rotulo.tipo[form.tipo] + ' · vento ' + rotulo.vento[form.vento]) +
      linha('Fatores', c.fatores.capa + ' × ' + c.fatores.tipo + ' × ' + c.fatores.vento) +
      linha('Acessórios', acessoriosTexto() + (c.acessoriosKcal ? ' (+' + fmtInt(c.acessoriosKcal) + ' kcal)' : '')) +
      linha('Tarifa', 'R$ ' + Number(form.tarifa).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + '/kWh') +
      linha('Profissional', esc(contato.perfil) + ' · ' + esc(contato.nome) + (contato.empresa ? ' · ' + esc(contato.empresa) : '')) +
      linha('Projeto', esc((contato.cidade ? contato.cidade + '/' : '') + contato.uf)) +
      linha('Emitido em', new Date().toLocaleString('pt-BR')) +
      '</table></div>';

    h += '<div class="r-disc">Resultado preliminar, sem valor de projeto executivo ou garantia de desempenho. A seleção automática segue a ordem de quantidade e modelos da planilha técnica. Valide com quem conhece o projeto.</div>';
    h += '<div class="r-actions">' +
      (CFG.marca.whatsapp ? '<a class="dim-btn zap" id="btnZap" target="_blank" rel="noopener">Enviar resumo por WhatsApp</a>' : '') +
      '<button type="button" class="dim-btn ghost" id="btnPrint">Imprimir / PDF</button>' +
      '<button type="button" class="dim-btn ghost" id="btnEdit">Ajustar dados</button></div>';

    $('step4').innerHTML = h;
    document.querySelectorAll('[data-opt]').forEach(function (b) { b.addEventListener('click', function () { escolha = opcoesAtuais[Number(b.dataset.opt)]; renderResultado(); }); });
    if ($('btnZap')) $('btnZap').href = 'https://wa.me/' + CFG.marca.whatsapp + '?text=' + encodeURIComponent(resumoWhatsApp(p));
    $('btnPrint').addEventListener('click', function () { window.print(); });
    $('btnEdit').addEventListener('click', function () { mostrarEtapa(1); });
  }

  function kpi(k, v, u, c, cls) { return '<div class="r-kpi ' + (cls || '') + '"><div class="k">' + k + '</div><div class="v">' + v + ' <small>' + u + '</small></div><div class="c">' + c + '</div></div>'; }
  function linha(k, v) { return '<tr><th>' + k + '</th><td>' + v + '</td></tr>'; }
  function acessoriosTexto() {
    var a = [];
    if (form.temPrainha && form.modoVolume === 'medidas') a.push('prainha');
    if (form.temCascata) a.push('cascata ' + form.cascataCm + ' cm');
    if (form.temInfinita) a.push('borda infinita' + (form.infinitaBordaM ? ' ' + form.infinitaBordaM + ' m' : ''));
    return a.length ? a.join(', ') : 'nenhum';
  }

  function resumoWhatsApp(p) {
    var s = escolha, c = s.carga;
    return [
      '*Dimensionamento de bomba de calor*',
      '',
      'Profissional: ' + contato.nome + (contato.empresa ? ' (' + contato.empresa + ')' : '') + ' - ' + contato.perfil,
      'Projeto: ' + (contato.cidade ? contato.cidade + '/' : '') + contato.uf,
      'WhatsApp: ' + contato.whatsapp,
      '',
      'Volume: ' + fmtInt(c.volumeLitros) + ' L',
      'Temperatura: ' + form.tempInicial + ' -> ' + form.tempDesejada + ' C',
      'Condicao: ' + rotulo.capa[form.capa] + ', ' + rotulo.tipo[form.tipo] + ', vento ' + rotulo.vento[form.vento],
      'Acessorios: ' + acessoriosTexto(),
      'Carga: ' + fmtInt(c.kcal) + ' kcal (' + fmtInt(c.btu) + ' BTU)',
      '',
      '*Indicado: ' + s.quantidade + ' x ' + s.modelo.nome + '*',
      fmtInt(s.totalBtu) + ' BTU/h · ' + fmt1(s.horasDia) + ' h/dia · primeiro aquecimento ' + fmt1(s.horasPrimeiroAquecimento) + ' h',
      'Custo anual estimado: ' + brl(p.custoAno) + ' (tarifa R$ ' + form.tarifa + '/kWh, ' + p.referencia + ')',
      'Motobomba: ' + (s.hidraulica.bomba ? s.hidraulica.bomba.cv + ' cv' : 'validar'),
      '',
      'Gerado em ' + new Date().toLocaleString('pt-BR') + ' - resultado preliminar.',
    ].join('\n');
  }

  mostrarEtapa(1);
})();
