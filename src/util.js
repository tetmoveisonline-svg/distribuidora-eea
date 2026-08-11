'use strict';

// Formata centavos (inteiro) como R$ 1.234,56
function formatBRL(centavos) {
  const v = (Number(centavos || 0) / 100);
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Formata data/hora no fuso de Sao Paulo: 16/07/2026 09:14
function formatDateTime(d) {
  if (!d) return '-';
  const date = (d instanceof Date) ? d : new Date(d);
  return date.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Converte "4,50" ou "4.50" em centavos (450). Retorna null se invalido.
function parsePrecoToCentavos(txt) {
  if (txt === null || txt === undefined) return null;
  let s = String(txt).trim().replace(/\s/g, '').replace('R$', '');
  if (s === '') return null;
  // Remove separador de milhar e normaliza a virgula decimal.
  if (s.indexOf(',') !== -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const v = Number(s);
  if (!isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

// Horas restantes ate expirar (numero, pode ser negativo se ja expirou).
function horasRestantes(expiraEm) {
  if (!expiraEm) return null;
  const ms = new Date(expiraEm).getTime() - Date.now();
  return ms / (1000 * 60 * 60);
}

function etiquetasExpiradas(expiraEm) {
  const h = horasRestantes(expiraEm);
  return h === null ? true : h <= 0;
}

module.exports = {
  formatBRL,
  formatDateTime,
  parsePrecoToCentavos,
  horasRestantes,
  etiquetasExpiradas,
};
