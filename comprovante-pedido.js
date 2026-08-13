'use strict';

const { gerarComprovante } = require('./comprovante');

// Monta o comprovante lendo tudo do banco. Aceita "runner" = db ou client de transacao.
async function gerarComprovanteDoPedido(runner, pedidoId) {
  const p = await runner.query(
    `SELECT pd.*, c.nome AS cliente_nome, c.email AS cliente_email
     FROM pedidos pd JOIN clientes c ON c.id = pd.cliente_id WHERE pd.id = $1`, [pedidoId]
  );
  if (p.rowCount === 0) throw new Error('Pedido nao encontrado para o comprovante.');
  const ped = p.rows[0];
  const l = await runner.query('SELECT * FROM linhas WHERE pedido_id = $1 ORDER BY id', [pedidoId]);

  return gerarComprovante({
    numero: ped.numero,
    criadoEm: ped.criado_em,
    aceiteEm: ped.aceite_em,
    aceiteIp: ped.aceite_ip,
    empresa: {
      nome: process.env.EMPRESA_NOME || 'Sua Empresa / Nome',
      cnpj: process.env.EMPRESA_CNPJ || '',
      contato: process.env.EMPRESA_CONTATO || '',
    },
    cliente: { nome: ped.cliente_nome, email: ped.cliente_email },
    linhas: l.rows.map((x) => ({
      arquivo_nome: x.arquivo_nome,
      item_nome: x.item_nome,
      cor_nome: x.cor_nome,
      quantidade: x.quantidade,
      preco_centavos: x.preco_centavos,
      bruto_centavos: x.bruto_centavos,
      desconto_centavos: x.desconto_centavos,
      total_centavos: x.total_centavos,
    })),
    totalEtiquetas: ped.total_etiquetas,
    subtotalCentavos: ped.subtotal_centavos,
    descontoItensCentavos: ped.desconto_itens_centavos,
    descontoTotalCentavos: ped.desconto_total_centavos,
    totalCentavos: ped.total_centavos,
    formaPagamento: process.env.COMPROVANTE_FORMA_PAGAMENTO || 'A combinar',
    prazoDespacho: process.env.COMPROVANTE_PRAZO_DESPACHO || 'Ate 1 dia util apos o aceite',
    observacoes: ped.observacoes || '',
  });
}

module.exports = { gerarComprovanteDoPedido };
