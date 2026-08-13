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
