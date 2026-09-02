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

// Formata pontos-base como percentual: 500 -> "5%", 550 -> "5,5%"
function formatPercent(bps) {
  const v = Number(bps || 0) / 100;
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + '%';
}

// Converte "5" ou "5,5" em pontos-base (500 / 550). Retorna null se invalido.
function parsePercentToBps(txt) {
  if (txt === null || txt === undefined) return null;
  let s = String(txt).trim().replace(/\s/g, '').replace('%', '');
  if (s === '') return null;
  if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
  const v = Number(s);
  if (!isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

// Comissao em centavos = total * bps / 10000, arredondado.
function comissaoCentavos(totalCentavos, bps) {
  if (!bps || !totalCentavos) return 0;
  return Math.round((Number(totalCentavos) * Number(bps)) / 10000);
}

// Etapas do andamento do pedido (para a timeline).
// Fluxo: Aceito -> Recebido -> Em separação -> Despachado.
// 'preparando' e preparando_em sao tratados como legado (pedidos antigos) e mapeados para "Em separação".
function andamento(pedido) {
  const st = pedido.status;
  const despachado = st === 'despachado';
  const emSeparacao = st === 'separacao' || st === 'preparando';
  const sepData = pedido.separacao_em || pedido.preparando_em || null;
  return [
    { chave: 'aceito', label: 'Aceito', data: pedido.aceite_em, done: true },
    { chave: 'recebido', label: 'Recebido', data: pedido.criado_em, done: true },
    { chave: 'separacao', label: 'Em separação', data: sepData,
      done: emSeparacao || despachado, current: emSeparacao && !despachado },
    { chave: 'despachado', label: 'Despachado', data: pedido.despachado_em,
      done: despachado, current: false },
  ];
}

// Andamento pronto para exibir (datas ja formatadas).
function andamentoDisplay(pedido) {
  return andamento(pedido).map((p) => ({
    label: p.label,
    done: p.done,
    current: !!p.current,
    quando: p.data ? formatDateTime(p.data) : '',
  }));
}

module.exports = {
  formatBRL,
  formatDateTime,
  parsePrecoToCentavos,
  horasRestantes,
  etiquetasExpiradas,
  formatPercent,
  parsePercentToBps,
  comissaoCentavos,
  andamento,
  andamentoDisplay,
};
