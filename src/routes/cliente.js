'use strict';

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { exigeCliente, exigeLogin } = require('../auth');
const imagens = require('../imagens');
const { contarPaginas, enviarEtiquetas, recortarPrimeirasPaginas } = require('../etiquetas');
const { gerarComprovante } = require('../comprovante');
const financeiro = require('../financeiro');
const estoque = require('../estoque');
const { formatBRL, formatDateTime, horasRestantes, etiquetasExpiradas, andamentoDisplay } = require('../util');

// Catalogo do cliente: todos os produtos ativos ao preco sugerido, ou ao negociado quando houver
// (com promocao), com cores, SKU e estoque disponivel. Ver src/precos.js.
const precos = require('../precos');
async function itensComPreco(q, clienteId) {
  return (await precos.catalogoDoCliente(q, clienteId)).map((x) => ({ ...x, sku: null }));
}

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) return cb(null, true);
    cb(null, false);
  },
});

function pad2(n) { return String(n).padStart(2, '0'); }
function enviarPdf(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buffer);
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }

// Normaliza os codigos recebidos do navegador em um array [{br,nfe}, ...] com tamanho = paginas.
// Aceita string JSON ou array ja pronto. Retorna null se nao houver nada util.
function sanCod(v) { if (v === null || v === undefined) return null; const s = String(v).trim().toUpperCase(); return s ? s.slice(0, 80) : null; }
function normalizarCodigos(raw, paginas) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (e) { arr = null; } }
  if (!Array.isArray(arr)) return null;
  const out = [];
  let algum = false;
  for (let i = 0; i < paginas; i++) {
    const p = arr[i] && typeof arr[i] === 'object' ? arr[i] : {};
    const br = sanCod(p.br);
    const nfe = sanCod(p.nfe);
    if (br || nfe) algum = true;
    out.push({ br: br, nfe: nfe });
  }
  return algum ? out : null;
}

// ---------- Novo envio ----------
router.get('/novo', exigeCliente, async (req, res, next) => {
  try {
    const itens = { rows: await itensComPreco(db, req.session.user.clienteId) };
    const credito = await financeiro.creditoCliente(req.session.user.clienteId);
    const cli = await db.query('SELECT nome FROM clientes WHERE id = $1', [req.session.user.clienteId]);
    // WhatsApp da distribuidora (so digitos, com DDI). Vazio = botao nao aparece.
    const whatsapp = (process.env.EMPRESA_WHATSAPP || '').replace(/\D/g, '');
    res.render('cliente/novo', {
      itens: itens.rows, credito, contato: process.env.EMPRESA_CONTATO || '', whatsapp,
      clienteNome: (cli.rows[0] && cli.rows[0].nome) || req.session.user.nome, clienteLogin: req.session.user.login || '',
      formatBRL,
    });
  } catch (e) { next(e); }
});

// ---------- Upload + deteccao de paginas ----------
router.post('/api/upload', exigeCliente, upload.array('arquivos', 30), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ erro: 'Envie ao menos um PDF.' });
    // Codigos lidos no navegador (um conjunto {br,nfe} por pagina), alinhados aos arquivos.
    const codigosBody = req.body && req.body.codigos;
    const codigosArr = Array.isArray(codigosBody) ? codigosBody : (codigosBody !== undefined ? [codigosBody] : []);
    const resultado = [];
    for (let fi = 0; fi < req.files.length; fi++) {
      const f = req.files[fi];
      let paginas = 0;
      try { paginas = await contarPaginas(f.buffer); }
      catch (e) { return res.status(400).json({ erro: 'Nao consegui ler o PDF "' + f.originalname + '". Verifique o arquivo.' }); }
      if (paginas < 1) return res.status(400).json({ erro: 'O arquivo "' + f.originalname + '" nao tem paginas validas.' });
      const codigos = normalizarCodigos(codigosArr[fi], paginas);
      const ins = await db.query('INSERT INTO arquivos (usuario_id, nome, paginas, conteudo, codigos) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [req.session.user.id, f.originalname, paginas, f.buffer, codigos ? JSON.stringify(codigos) : null]);
      resultado.push({ id: ins.rows[0].id, nome: f.originalname, paginas });
    }
    res.json({ arquivos: resultado });
  } catch (e) { console.error('Erro no upload:', e); res.status(500).json({ erro: 'Falha ao processar o upload.' }); }
});

// ---------- Criar pedido (aceite) ----------
router.post('/api/pedidos', exigeCliente, async (req, res) => {
  const clienteId = req.session.user.clienteId;
  const usuarioId = req.session.user.id;
  const body = req.body || {};
  const linhasReq = Array.isArray(body.itens) ? body.itens : [];

  if (body.aceite !== true) return res.status(400).json({ erro: 'E preciso confirmar os envios e valores para aceitar.' });
  if (linhasReq.length === 0) return res.status(400).json({ erro: 'Nenhum arquivo/item para gerar o pedido.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Preco efetivo (promocao vigente) no momento do aceite; a linha guarda o preco realmente cobrado.
    const itensMap = new Map((await itensComPreco(client, clienteId)).map((i) => [i.id, i]));

    const linhas = [];
    let totalCentavos = 0, totalEtiquetas = 0;
    for (const l of linhasReq) {
      const arquivoId = parseInt(l.arquivoId, 10);
      const itemKey = typeof l.itemId === 'string' && /^p\d+$/.test(l.itemId) ? l.itemId : parseInt(l.itemId, 10);
      const quantidade = parseInt(l.quantidade, 10);
      if (!arquivoId || !itemKey || !quantidade || quantidade < 1) throw httpErr(400, 'Dados invalidos em uma das linhas.');
      const item = itensMap.get(itemKey);
      if (!item) throw httpErr(400, 'Item invalido para este cliente.');
      // produto sem negociacao: cria o vinculo (itens) no aceite, ao preco sugerido de agora
      item.id = await precos.garantirItem(client, clienteId, item);
      // Cor: obrigatoria quando o produto tem cores cadastradas.
      let cor = null;
      if (item.cores.length > 0) {
        const corId = parseInt(l.corId, 10);
        cor = item.cores.find((c) => c.id === corId) || null;
        if (!cor) throw httpErr(400, 'Escolha a cor de "' + item.nome + '" antes de aceitar.');
      }
      const arq = await client.query('SELECT id, nome, paginas, codigos FROM arquivos WHERE id = $1 AND usuario_id = $2 AND pedido_id IS NULL', [arquivoId, usuarioId]);
      if (arq.rowCount === 0) throw httpErr(400, 'Arquivo invalido ou ja utilizado.');
      const totalLinha = item.preco_centavos * quantidade;
      totalCentavos += totalLinha; totalEtiquetas += quantidade;
      linhas.push({
        arquivoId, arquivoNome: arq.rows[0].nome, paginas: arq.rows[0].paginas, codigos: arq.rows[0].codigos || [],
        itemId: item.id, itemNome: cor ? item.nome + ' · ' + cor.nome : item.nome,
        corId: cor ? cor.id : null, corNome: cor ? cor.nome : null, sku: cor ? cor.sku : item.sku,
        precoCentavos: item.preco_centavos, quantidade, totalCentavos: totalLinha,
      });
    }

    // Limite de credito: o que esta em aberto no financeiro consome o limite; vencido pode bloquear.
    const credito = await financeiro.creditoCliente(clienteId);
    if (credito && credito.bloqueado) {
      throw httpErr(400, 'Há pedido vencido em aberto (' + credito.maisVencido.numero + ', ' + formatBRL(credito.maisVencido.valor) + '). Regularize o pagamento para liberar novos envios.');
    }
    if (credito && credito.controlado && totalCentavos > credito.disponivel) {
      throw httpErr(400, 'O pedido (' + formatBRL(totalCentavos) + ') ultrapassa seu crédito disponível (' + formatBRL(credito.disponivel) + '). Reduza a quantidade ou fale com a empresa para liberar saldo.');
    }

    const seq = await client.query("SELECT 'DS-' || nextval('pedido_numero_seq') AS numero");
    const numero = seq.rows[0].numero;
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

    const ped = await client.query(
      `INSERT INTO pedidos (numero, cliente_id, usuario_id, status, total_centavos, total_etiquetas, aceite_em, aceite_ip, etiquetas_expira_em)
       VALUES ($1,$2,$3,'aguardando',$4,$5, now(), $6, now() + interval '72 hours')
       RETURNING id, criado_em, aceite_em`,
      [numero, clienteId, usuarioId, totalCentavos, totalEtiquetas, ip]
    );
    const pedidoId = ped.rows[0].id;

    // Comissao automatica a partir do cadastro do cliente (quem agregou + %).
    //   Preposto: representante_id = preposto (fatia dele) e responsavel_id = representante-pai (resto do total).
    //   Representante direto: representante_id = ele, com o % total; sem responsavel.
    const cc = await client.query(
      `SELECT c.comissao_total_bps, c.comissao_preposto_bps,
              u.id AS u_id, u.comissao_bps AS u_bps, u.representante_pai_id
       FROM clientes c LEFT JOIN usuarios u ON u.id = c.representante_id AND u.papel = 'representante'
       WHERE c.id = $1`, [clienteId]
    );
    const comRow = cc.rows[0];
    if (comRow && comRow.u_id) {
      const totalBps = parseInt(comRow.comissao_total_bps != null ? comRow.comissao_total_bps : (comRow.u_bps || 0), 10) || 0;
      if (totalBps > 0) {
        if (comRow.representante_pai_id) {
          let prepBps = parseInt(comRow.comissao_preposto_bps != null ? comRow.comissao_preposto_bps : (comRow.u_bps || 0), 10) || 0;
          if (prepBps > totalBps) prepBps = totalBps;
          const paiBps = totalBps - prepBps;
          await client.query(
            `UPDATE pedidos SET representante_id = $2, comissao_bps = $3, comissao_centavos = $4,
                    responsavel_id = $5, comissao_resp_bps = $6, comissao_resp_centavos = $7 WHERE id = $1`,
            [pedidoId, comRow.u_id, prepBps, Math.round(totalCentavos * prepBps / 10000),
             comRow.representante_pai_id, paiBps, Math.round(totalCentavos * paiBps / 10000)]
          );
        } else {
          await client.query(
            `UPDATE pedidos SET representante_id = $2, comissao_bps = $3, comissao_centavos = $4 WHERE id = $1`,
            [pedidoId, comRow.u_id, totalBps, Math.round(totalCentavos * totalBps / 10000)]
          );
        }
      }
    }

    let indiceGlobal = 0;
    for (const l of linhas) {
      // Regra: quantidade menor que o PDF -> valem sempre as PRIMEIRAS paginas. O arquivo guardado
      // e recortado para essas N paginas, e os codigos lidos seguem alinhados (indices 0..N-1).
      if (l.paginas && l.quantidade < l.paginas) {
        const orig = await client.query('SELECT conteudo FROM arquivos WHERE id = $1', [l.arquivoId]);
        const cortado = await recortarPrimeirasPaginas(orig.rows[0].conteudo, l.quantidade);
        l.codigos = (Array.isArray(l.codigos) ? l.codigos : []).slice(0, l.quantidade);
        await client.query('UPDATE arquivos SET conteudo = $1, paginas = $2, codigos = $3 WHERE id = $4',
          [cortado, l.quantidade, JSON.stringify(l.codigos), l.arquivoId]);
      }
      await client.query('UPDATE arquivos SET pedido_id = $1 WHERE id = $2', [pedidoId, l.arquivoId]);
      const linhaIns = await client.query(
        `INSERT INTO linhas (pedido_id, arquivo_id, item_id, item_nome, arquivo_nome, preco_centavos, quantidade, total_centavos, cor_id, cor_nome, sku)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [pedidoId, l.arquivoId, l.itemId, l.itemNome, l.arquivoNome, l.precoCentavos, l.quantidade, l.totalCentavos, l.corId, l.corNome, l.sku]
      );
      const linhaId = linhaIns.rows[0].id;
      const cods = Array.isArray(l.codigos) ? l.codigos : [];
      for (let i = 0; i < l.quantidade; i++) {
        indiceGlobal++;
        const c = cods[i] && typeof cods[i] === 'object' ? cods[i] : {};
        const br = c.br || null, nfe = c.nfe || null;
        await client.query(
          'INSERT INTO etiquetas (pedido_id, linha_id, codigo, indice, codigo_externo, codigo_nfe) VALUES ($1,$2,$3,$4,$5,$6)',
          [pedidoId, linhaId, numero + '-' + pad2(indiceGlobal), indiceGlobal, br, nfe]
        );
      }
    }

    const cli = await client.query('SELECT nome, email FROM clientes WHERE id = $1', [clienteId]);
    const pdfBuffer = await gerarComprovante({
      numero, criadoEm: ped.rows[0].criado_em, aceiteEm: ped.rows[0].aceite_em, aceiteIp: ip,
      empresa: { nome: process.env.EMPRESA_NOME || 'A4 Móveis Distribuidora', cnpj: process.env.EMPRESA_CNPJ || '', contato: process.env.EMPRESA_CONTATO || '' },
      cliente: cli.rows[0] || {},
      linhas: linhas.map((l) => ({ arquivo_nome: l.arquivoNome, item_nome: l.itemNome + (l.sku ? ' [' + l.sku + ']' : ''), quantidade: l.quantidade, preco_centavos: l.precoCentavos, total_centavos: l.totalCentavos })),
      totalEtiquetas, totalCentavos,
      formaPagamento: process.env.COMPROVANTE_FORMA_PAGAMENTO || 'A combinar',
      prazoDespacho: process.env.COMPROVANTE_PRAZO_DESPACHO || 'Ate 1 dia util apos o aceite',
      observacoes: (body.observacoes || '').toString().slice(0, 500),
    });
    await client.query('UPDATE pedidos SET comprovante = $1 WHERE id = $2', [pdfBuffer, pedidoId]);

    // Estoque: reserva a quantidade de cada linha (o despacho consome depois).
    await estoque.reservarPedido(client, pedidoId, usuarioId);

    // Lancamento financeiro do pedido (valor total, vencimento = aceite + prazo do cliente).
    await financeiro.criarLancamento(client, pedidoId, clienteId, totalCentavos, totalEtiquetas);

    await client.query('COMMIT');
    res.json({ ok: true, pedidoId, numero });
  } catch (e) {
    await client.query('ROLLBACK');
    const status = e.status || 500;
    if (status === 500) console.error('Erro ao criar pedido:', e);
    res.status(status).json({ erro: e.publicMessage || 'Falha ao gerar o pedido.' });
  } finally { client.release(); }
});

// ---------- Meus envios ----------
router.get('/meus-envios', exigeCliente, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, numero, status, total_centavos, total_etiquetas, aceite_em, criado_em, etiquetas_expira_em, preparando_em, despachado_em
       FROM pedidos WHERE cliente_id = $1 ORDER BY id DESC`, [req.session.user.clienteId]
    );
    const pedidos = r.rows.map((p) => ({ ...p, expirado: etiquetasExpiradas(p.etiquetas_expira_em), horas: horasRestantes(p.etiquetas_expira_em), passos: andamentoDisplay(p) }));

    // Detalhe por etiqueta (horario do bipe de despacho) de todos os pedidos, numa unica consulta.
    const ids = pedidos.map((p) => p.id);
    const etqMap = new Map();
    if (ids.length > 0) {
      const er = await db.query(
        `SELECT e.pedido_id, e.indice, e.status, e.despachado_em, l.item_nome
         FROM etiquetas e LEFT JOIN linhas l ON l.id = e.linha_id
         WHERE e.pedido_id = ANY($1::int[]) ORDER BY e.pedido_id, e.indice`, [ids]
      );
      for (const row of er.rows) {
        if (!etqMap.has(row.pedido_id)) etqMap.set(row.pedido_id, []);
        etqMap.get(row.pedido_id).push(row);
      }
    }
    pedidos.forEach((p) => {
      const arr = etqMap.get(p.id) || [];
      p.etiquetas = arr;
      p.etqDespachadas = arr.filter((e) => e.status === 'despachado').length;
      p.etqTotal = arr.length;
    });

    res.render('cliente/meus-envios', { pedidos, formatBRL, formatDateTime });
  } catch (e) { next(e); }
});

// ---------- Inicio (painel do cliente) ----------
router.get('/inicio', exigeCliente, async (req, res, next) => {
  try {
    const clienteId = req.session.user.clienteId;
    const [credito, catalogo, fin] = await Promise.all([
      financeiro.creditoCliente(clienteId),
      estoque.saldosParaCliente(clienteId),
      financeiro.listar({ clienteId }),
    ]);
    const resumoFin = financeiro.resumo(fin);
    // pedidos em andamento com progresso de despacho e itens
    const ped = await db.query(
      `SELECT p.id, p.numero, p.status, p.total_etiquetas, p.total_centavos, p.aceite_em, p.etiquetas_expira_em,
              (SELECT count(*) FROM etiquetas e WHERE e.pedido_id = p.id AND e.status = 'despachado')::int AS despachadas,
              (SELECT count(*) FROM etiquetas e WHERE e.pedido_id = p.id AND e.status = 'conferido')::int AS separadas,
              (SELECT string_agg(l.item_nome || ' · ' || l.quantidade, ', ' ORDER BY l.id) FROM linhas l WHERE l.pedido_id = p.id) AS itens
       FROM pedidos p WHERE p.cliente_id = $1 AND p.status <> 'despachado' ORDER BY p.id DESC`, [clienteId]
    );
    const andamento = ped.rows.map((p) => ({ ...p, pct: p.total_etiquetas ? Math.round(p.despachadas / p.total_etiquetas * 100) : 0, horas: horasRestantes(p.etiquetas_expira_em), expirado: etiquetasExpiradas(p.etiquetas_expira_em) }));
    const reservado = catalogo.reduce((n, p) => n + (p.cores.length ? p.cores.reduce((m, c) => m + (c.meu_reservado || 0), 0) : (p.meu_reservado || 0)), 0);
    const coresReservadas = catalogo.reduce((n, p) => n + (p.cores.length ? p.cores.filter((c) => c.meu_reservado > 0).length : (p.meu_reservado > 0 ? 1 : 0)), 0);
    const nov = await require('../novidades').listarParaCliente(clienteId, catalogo.map((p) => p.id), 30);
    const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const h = parseInt(hora.slice(0, 2), 10);
    const saud = h < 12 ? 'Bom dia' : (h < 18 ? 'Boa tarde' : 'Boa noite');
    res.render('cliente/inicio', {
      credito, resumoFin, andamento, reservado, coresReservadas, novidades: nov, saud, hora,
      etiquetasDesp: andamento.reduce((n, p) => n + p.despachadas, 0), etiquetasTotal: andamento.reduce((n, p) => n + p.total_etiquetas, 0),
      novasHoje: nov.filter((n) => n.hoje).length, formatBRL, formatDateTime,
    });
  } catch (e) { next(e); }
});

// ---------- Estoque (produtos com preco negociado) ----------
router.get('/estoque', exigeCliente, async (req, res, next) => {
  try {
    const produtos = await imagens.anexar(await estoque.saldosParaCliente(req.session.user.clienteId));
    res.render('cliente/estoque', { produtos, formatDateTime });
  } catch (e) { next(e); }
});
// Imagem do produto (qualquer usuario logado); ?baixar=1 forca o download.
router.get('/produtos/:id/imagens/:img', exigeLogin, (req, res, next) => imagens.servir(req, res).catch(next));
router.get('/api/estoque', exigeCliente, async (req, res) => {
  try {
    const produtos = await imagens.anexar(await estoque.saldosParaCliente(req.session.user.clienteId));
    res.json({ ok: true, produtos, atualizado_em: formatDateTime(new Date()) });
  } catch (e) { console.error('Erro estoque cliente:', e); res.status(500).json({ erro: 'Falha ao carregar o estoque.' }); }
});

// ---------- Financeiro (um lancamento por pedido) ----------
router.get('/financeiro', exigeCliente, async (req, res, next) => {
  try {
    const clienteId = req.session.user.clienteId;
    const sit = ['todos', 'aberto', 'vencido', 'pago'].includes(req.query.situacao) ? req.query.situacao : 'todos';
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : '';
    const todos = await financeiro.listar({ clienteId });
    const lista = financeiro.filtrarSituacao(mes ? await financeiro.listar({ clienteId, mes }) : todos, sit);
    res.render('cliente/financeiro', {
      lancamentos: lista, resumo: financeiro.resumo(todos), creditoConta: await financeiro.creditoConta(clienteId),
      meses: await financeiro.mesesDisponiveis(clienteId), filtro: { situacao: sit, mes },
      formatBRL, formatDateTime,
    });
  } catch (e) { next(e); }
});

// ---------- Download: etiquetas (72h) - arquivos separados nomeados pelo produto ----------
router.get('/pedido/:id/etiquetas', exigeCliente, async (req, res, next) => {
  try {
    const p = await db.query('SELECT id, numero, etiquetas_expira_em FROM pedidos WHERE id = $1 AND cliente_id = $2', [req.params.id, req.session.user.clienteId]);
    if (p.rowCount === 0) return res.status(404).render('erro', { titulo: 'Pedido nao encontrado', mensagem: 'Pedido inexistente.', user: req.session.user });
    if (etiquetasExpiradas(p.rows[0].etiquetas_expira_em)) {
      return res.status(410).render('erro', { titulo: 'Etiquetas expiradas', mensagem: 'As etiquetas deste pedido expiraram (validade de 72h). Reenvie para gerar novas.', user: req.session.user });
    }
    const arqs = await db.query(
      `SELECT a.nome AS arquivo_nome, a.conteudo, l.item_nome
       FROM arquivos a LEFT JOIN linhas l ON l.arquivo_id = a.id WHERE a.pedido_id = $1 ORDER BY a.id`, [p.rows[0].id]
    );
    if (arqs.rowCount === 0) return res.status(404).render('erro', { titulo: 'Sem etiquetas', mensagem: 'Nenhum arquivo de etiqueta neste pedido.', user: req.session.user });
    enviarEtiquetas(res, p.rows[0].numero, arqs.rows);
  } catch (e) { next(e); }
});

// ---------- Download: comprovante (permanente) ----------
router.get('/pedido/:id/comprovante', exigeCliente, async (req, res, next) => {
  try {
    const p = await db.query('SELECT numero, comprovante FROM pedidos WHERE id = $1 AND cliente_id = $2', [req.params.id, req.session.user.clienteId]);
    if (p.rowCount === 0 || !p.rows[0].comprovante) return res.status(404).render('erro', { titulo: 'Comprovante indisponivel', mensagem: 'Comprovante nao encontrado.', user: req.session.user });
    enviarPdf(res, 'comprovante-' + p.rows[0].numero + '.pdf', p.rows[0].comprovante);
  } catch (e) { next(e); }
});

module.exports = router;
