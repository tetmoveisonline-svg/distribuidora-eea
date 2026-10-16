// Troca e persiste o tema no navegador. O anti-flash fica no <head> de cada pagina.
(function () {
  var sel = document.getElementById('theme');
  var cur = 'escuro-minimal';
  try { cur = localStorage.getItem('ds_theme') || 'escuro-minimal'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', cur);
  if (sel) {
    sel.value = cur;
    sel.addEventListener('change', function () {
      document.documentElement.setAttribute('data-theme', sel.value);
      try { localStorage.setItem('ds_theme', sel.value); } catch (e) {}
    });
  }
})();

// Abre/fecha o detalhe por etiqueta (bipe de despacho). Delegado: funciona para varios blocos na pagina.
document.addEventListener('click', function (ev) {
  var h = ev.target.closest ? ev.target.closest('.disc-head') : null;
  if (h && h.parentElement && h.parentElement.classList.contains('disc')) {
    h.parentElement.classList.toggle('open');
  }
});

// Financeiro: abre/fecha o detalhe de um lancamento.
document.addEventListener('click', function (ev) {
  var b = ev.target.closest ? ev.target.closest('.fin-toggle') : null;
  if (!b) return;
  var d = document.getElementById('fin-detail-' + b.getAttribute('data-fin'));
  if (!d) return;
  var aberto = d.style.display !== 'none';
  d.style.display = aberto ? 'none' : 'table-row';
  b.textContent = aberto ? 'detalhe' : 'fechar';
});

// Radio da area do cliente: comeca pausada; so toca quando o cliente clica. Volume lembrado no navegador.
(function () {
  var box = document.getElementById('radio'); if (!box) return;
  var a = document.getElementById('radioAudio'), btn = document.getElementById('radioBtn'), st = document.getElementById('radioSt'), vol = document.getElementById('radioVol');
  try { var v = localStorage.getItem('radioVol'); if (v !== null) vol.value = v; } catch (e) {}
  a.volume = vol.value / 100;
  vol.addEventListener('input', function () { a.volume = vol.value / 100; try { localStorage.setItem('radioVol', vol.value); } catch (e) {} });
  function estado(t, on) { st.textContent = t; box.classList.toggle('on', !!on); btn.innerHTML = on ? '&#10074;&#10074;' : '&#9654;'; btn.setAttribute('aria-label', on ? 'Pausar rádio' : 'Tocar rádio'); }
  btn.addEventListener('click', function () {
    if (a.paused) {
      estado('Conectando...', true);
      a.load();
      a.play().catch(function () { estado('Não foi possível tocar agora', false); });
    } else { a.pause(); }
  });
  a.addEventListener('playing', function () { estado('Ao vivo', true); });
  a.addEventListener('pause', function () { estado('Parada · toque para ouvir', false); });
  a.addEventListener('error', function () { estado('Sem sinal no momento', false); });
})();

// Contador "online" no topo do admin: atualiza a cada 30s.
(function () {
  var n = document.getElementById('onlineN'); if (!n) return;
  function up() { fetch('/admin/online.json').then(function (r) { return r.json(); }).then(function (d) { if (d && d.ok) n.textContent = d.online; }).catch(function () {}); }
  up(); setInterval(up, 30000);
})();

// Menu lateral como gaveta no celular.
(function () {
  var btn = document.getElementById('menuBtn'), side = document.getElementById('sideNav'), bd = document.getElementById('sideBackdrop');
  if (!btn || !side || !bd) return;
  function set(aberto) { side.classList.toggle('open', aberto); bd.classList.toggle('on', aberto); btn.setAttribute('aria-expanded', aberto ? 'true' : 'false'); document.body.style.overflow = aberto ? 'hidden' : ''; }
  btn.addEventListener('click', function () { set(!side.classList.contains('open')); });
  bd.addEventListener('click', function () { set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  side.querySelectorAll('a.nav-item').forEach(function (a) { a.addEventListener('click', function () { set(false); }); });
})();
