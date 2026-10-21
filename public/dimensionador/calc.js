/* Motor de calculo do Dimensionador de bomba de calor para piscina.
 * Puro: recebe a configuracao (fatores, modelos, clima) e os dados do formulario, devolve numeros.
 * Roda no navegador (window.DimCalc) e no Node (module.exports) para testes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DimCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  var DIAS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function num(v) {
    if (typeof v === 'string') v = v.replace(',', '.');
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function area(d) { return num(d && d.comprimento) * num(d && d.largura); }
  function volumeM3(d) { return area(d) * num(d && d.profundidade); }

  /* Carga termica (kcal) a partir dos dados da piscina. */
  function cargaTermica(cfg, f) {
    var F = cfg.fatores, K = cfg.constantes;
    var volPrainha = f.temPrainha ? volumeM3(f.prainha) : 0;
    var volInfinita = f.temInfinita ? volumeM3(f.infinita) : 0;
    var volM3 = f.modoVolume === 'medidas' ? volumeM3(f.principal) + volPrainha + volInfinita : num(f.litros) / 1000;
    var litros = volM3 * 1000;
    var delta = num(f.tempDesejada) - num(f.tempInicial);
    var fCapa = F.capa[f.capa], fTipo = F.tipo[f.tipo], fVento = F.vento[f.vento];
    var base = delta * fCapa * fTipo * fVento * litros;
    var kPrainha = f.temPrainha ? area(f.prainha) * F.acessorioKcal.prainha : 0;
    var kInfArea = f.temInfinita ? area(f.infinita) * F.acessorioKcal.infinita : 0;
    var kCascata = f.temCascata ? num(f.cascataCm) * (F.acessorioKcal.cascata / 100) : 0;
    var kInfBorda = f.temInfinita ? num(f.infinitaBordaM) * F.acessorioKcal.infinita : 0;
    var acess = kPrainha + kInfArea + kCascata + kInfBorda;
    var total = base + acess;
    return {
      volumeM3: volM3, volumeLitros: litros, deltaC: delta,
      fatores: { capa: fCapa, tipo: fTipo, vento: fVento },
      baseKcal: base, acessoriosKcal: acess,
      detalheAcessorios: { prainha: kPrainha, infinitaArea: kInfArea, cascata: kCascata, infinitaBorda: kInfBorda },
      kcal: total, btu: total * K.btuPorKcal, kw: total / K.kcalPorKwh,
    };
  }

  /* Pre-selecao de motobomba pela vazao necessaria e altura manometrica. */
  function motobomba(cfg, vazaoM3h, mca) {
    var alturas = [6, 8, 10, 12];
    var h = alturas.indexOf(num(mca)) >= 0 ? num(mca) : cfg.constantes.alturaManometricaPadrao;
    var v = Math.max(0, num(vazaoM3h));
    var bomba = null;
    for (var i = 0; i < cfg.motobombas.length; i++) {
      if (cfg.motobombas[i].vazao[h] >= v) { bomba = cfg.motobombas[i]; break; }
    }
    return { bomba: bomba, mca: h, vazaoNecessaria: v, vazaoDisponivel: bomba ? bomba.vazao[h] : 0, atende: !!bomba };
  }

  /* Avalia um modelo com N maquinas. */
  function avaliar(cfg, f, modelo, qtd) {
    var K = cfg.constantes;
    var c = cargaTermica(cfg, f);
    var n = Math.max(1, Math.min(K.maxMaquinas, Math.trunc(num(qtd))));
    var unitKcal = modelo.btu / K.btuPorKcal;
    var totalBtu = modelo.btu * n;
    var totalKcal = unitKcal * n;
    var horasDia = (c.volumeLitros * 2) / totalKcal;
    var horasPrimeiro = c.kcal / totalKcal;
    var recomendado = horasDia < K.limiteHorasDia && horasPrimeiro < K.limitePrimeiroAquecH;
    var kwMax = modelo.kw * n;
    var kwhMes = kwMax * horasDia * 30 + horasPrimeiro;
    var tarifa = num(f.tarifa);
    var hRec = [6, 8, 10, 12].indexOf(num(f.horasRecirculacao)) >= 0 ? num(f.horasRecirculacao) : K.horasRecirculacaoPadrao;
    var vazaoBomba = modelo.vazao * n;
    var vazaoRenovacao = c.volumeM3 / hRec;
    var hid = motobomba(cfg, Math.max(vazaoBomba, vazaoRenovacao), f.mca);
    hid.vazaoBombaCalor = vazaoBomba; hid.vazaoRenovacao = vazaoRenovacao; hid.horasRecirculacao = hRec;
    return {
      carga: c, modelo: modelo, quantidade: n,
      unitKcal: unitKcal, totalBtu: totalBtu, totalKcal: totalKcal, totalKw: totalKcal / K.kcalPorKwh,
      horasDia: horasDia, horasPrimeiroAquecimento: horasPrimeiro, recomendado: recomendado,
      kwMax: kwMax, kwhMes: kwhMes, kwhAno9: kwhMes * 9, kwhAno12: kwhMes * 12,
      custoMes: kwhMes * tarifa, custoAno9: kwhMes * 9 * tarifa, custoAno12: kwhMes * 12 * tarifa,
      hidraulica: hid,
    };
  }

  /* Primeira combinacao (menor quantidade, ordem do catalogo) que atende os criterios. */
  function selecionar(cfg, f) {
    var ultimo = null;
    for (var n = 1; n <= cfg.constantes.maxMaquinas; n++) {
      for (var i = 0; i < cfg.modelos.length; i++) {
        var r = avaliar(cfg, f, cfg.modelos[i], n);
        ultimo = r;
        if (r.recomendado) return r;
      }
    }
    return ultimo;
  }

  /* Opcoes por linha de produto: a primeira que atende e, se existir, uma alternativa com +1 maquina de porte parecido. */
  function opcoes(cfg, f) {
    var linhas = [];
    cfg.modelos.forEach(function (m) { if (linhas.indexOf(m.linha) < 0) linhas.push(m.linha); });
    var out = [];
    linhas.forEach(function (linha) {
      var ms = cfg.modelos.filter(function (m) { return m.linha === linha; });
      var base = null;
      for (var n = 1; n <= cfg.constantes.maxMaquinas && !base; n++) {
        for (var i = 0; i < ms.length; i++) {
          var r = avaliar(cfg, f, ms[i], n);
          if (r.recomendado) { base = r; break; }
        }
      }
      if (!base) return;
      out.push(base);
      var n2 = base.quantidade + 1;
      if (n2 <= cfg.constantes.maxMaquinas) {
        for (var j = 0; j < ms.length; j++) {
          var alt = avaliar(cfg, f, ms[j], n2);
          if (alt.recomendado) {
            var razao = alt.totalBtu / base.totalBtu;
            if (razao >= 0.8 && razao <= 1.25) out.push(alt);
            break;
          }
        }
      }
    });
    return out;
  }

  /* Projecao de consumo mes a mes pelo clima da UF. */
  function projecaoAnual(cfg, f, sel, uf) {
    var clima = cfg.clima[uf] || cfg.clima.SP;
    var ufUsada = cfg.clima[uf] ? uf : 'SP';
    var alvo = num(f.tempDesejada), tarifa = num(f.tarifa);
    var deltas = clima.t.map(function (t) { return Math.max(alvo - t, 0.5); });
    var mediaPond = deltas.reduce(function (s, d, i) { return s + d * DIAS[i]; }, 0) / 365;
    var kwhDiaBase = sel.kwMax * sel.horasDia;
    var sensib = f.tipo === 'fechada' ? 0.25 : 1;
    var meses = MESES.map(function (nome, i) {
      var fator = 1 + (deltas[i] / mediaPond - 1) * sensib;
      var kwh = kwhDiaBase * fator * DIAS[i];
      return { mes: nome, dias: DIAS[i], tempAr: clima.t[i], fator: fator, horasDia: sel.horasDia * fator, kwh: kwh, custo: kwh * tarifa };
    });
    var kwhAno = meses.reduce(function (s, m) { return s + m.kwh; }, 0);
    var custoAno = meses.reduce(function (s, m) { return s + m.custo; }, 0);
    var kwhPrimeiro = sel.kwMax * sel.horasPrimeiroAquecimento;
    var pico = meses.reduce(function (a, m) { return m.horasDia > a.horasDia ? m : a; }, meses[0]);
    return {
      uf: ufUsada, referencia: clima.ref + '/' + ufUsada, meses: meses,
      kwhAno: kwhAno, custoAno: custoAno,
      kwhPrimeiroAquecimento: kwhPrimeiro, custoPrimeiroAquecimento: kwhPrimeiro * tarifa,
      kwhPrimeiroAno: kwhAno + kwhPrimeiro, custoPrimeiroAno: custoAno + kwhPrimeiro * tarifa,
      mesPico: pico,
    };
  }

  return { num: num, area: area, volumeM3: volumeM3, cargaTermica: cargaTermica, motobomba: motobomba, avaliar: avaliar, selecionar: selecionar, opcoes: opcoes, projecaoAnual: projecaoAnual, MESES: MESES };
});
