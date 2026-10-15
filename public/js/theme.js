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
