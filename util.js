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
function andamento(pedido) {
  const st = pedido.status;
  return [
    { chave: 'aceito', label: 'Aceito', data: pedido.aceite_em, done: true },
    { chave: 'recebido', label: 'Recebido', data: pedido.criado_em, done: true },
    { chave: 'preparando', label: 'Em preparação', data: pedido.preparando_em,
      done: st === 'despachado', current: st === 'preparando' },
    { chave: 'despachado', label: 'Despachado', data: pedido.despachado_em,
      done: st === 'despachado', current: false },
  ];
}

// Desconto de um item (linha). bruto em centavos; qtd; tipo 'pct'|'val'; valor (bps ou centavos/unid).
function descontoItem(brutoCentavos, quantidade, tipo, valor) {
  if (!tipo || !valor) return 0;
  let d = 0;
  if (tipo === 'pct') d = Math.round((brutoCentavos * Number(valor)) / 10000);
  else if (tipo === 'val') d = Math.round(Number(valor)) * Number(quantidade); // valor por unidade
  if (d < 0) d = 0;
  if (d > brutoCentavos) d = brutoCentavos;
  return d;
}

// Desconto no total (sobre o subtotal ja com descontos de item). tipo 'pct'|'val'; valor (bps ou centavos).
function descontoTotal(subtotalCentavos, tipo, valor) {
  if (!tipo || !valor) return 0;
  let d = 0;
  if (tipo === 'pct') d = Math.round((subtotalCentavos * Number(valor)) / 10000);
  else if (tipo === 'val') d = Math.round(Number(valor)); // valor fixo no total
  if (d < 0) d = 0;
  if (d > subtotalCentavos) d = subtotalCentavos;
  return d;
}

// Texto curto do desconto: {tipo,valor} -> "10%" ou "R$ 5,00"
function formatDesconto(tipo, valor) {
  if (!tipo || !valor) return '—';
  if (tipo === 'pct') return formatPercent(valor);
  return formatBRL(valor);
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
  descontoItem,
  descontoTotal,
  formatDesconto,
};
