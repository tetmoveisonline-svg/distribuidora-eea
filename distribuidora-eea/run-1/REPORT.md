# Relatório de Auditoria de Segurança — A4 Móveis Distribuidora

**Projeto:** distribuidora-eea · **Commit:** `3e442fb` · **Perfil:** quick (passada parcial)
**Skill:** cloudflare/security-audit · **Execução:** somente fonte + testes locais em sandbox isolado (sem acesso à produção) · **Data:** 05/11/2026
**Agentes gastos:** reconhecimento (parent) + 1 verificador independente. Sem orçamento fixo. Sem rodadas anteriores (primeira auditoria).

> Esta é uma passada **quick** e **parcial**: uma rodada de investigação e uma verificação final. Ela não representa cobertura exaustiva. Itens cuja decisão depende do ambiente do Railway (variáveis, memória, versões de dependências) estão listados como **PRECISA VALIDAÇÃO**, sem severidade.

## Postura de segurança (resumo)
O sistema tem uma base sólida: SQL totalmente parametrizado (sem injeção de SQL), senhas com bcrypt, sessões server-side, isolamento por cliente consistente (sem IDOR encontrado) e o papel `operador` corretamente barrado de ver custos/comissões. Os pontos a corrigir concentram-se em **endurecimento de autenticação e de configuração** (limite de tentativas, segredos/padrões de ambiente) e em **um XSS de baixo impacto** no contexto de script. Não foi encontrada falha crítica confirmada no código; os itens de maior potencial dependem de como o ambiente está configurado no Railway.

## Achados confirmados

| Severidade | Título | Fronteira | Resultado observado |
|---|---|---|---|
| **Média** | Login sem limite de tentativas | Não autenticado → app | 6 tentativas erradas seguidas, todas 401, sem bloqueio; senha certa entra logo depois |
| **Baixa** | XSS armazenado via JSON não escapado em `<script>` | Admin/representante → cliente | `</script><script>` injetado no nome aparece cru em `/novo` e executa no navegador do cliente |

### 1. Login sem limite de tentativas (Média) — `login-no-rate-limit`
- **Local:** `src/routes/auth.js:25` (POST /login) → `:38` (bcrypt.compare), sem limitador; `src/server.js:67` (nenhum middleware de rate limit).
- **Principal de menor confiança:** atacante não autenticado.
- **Reprodução local (dados fictícios):** seis POSTs com senha errada para `admin` → HTTP 401 cada; em seguida a senha correta → HTTP 302 imediato.
- **Resultado real:** adivinhação de senha online ilimitada. Compõe-se com a senha padrão do admin (ver PRECISA VALIDAÇÃO).
- **Prioridade:** alta entre os itens — é barato de abusar e habilita o caminho de tomada de conta.
- **Menor correção eficaz:** rate limiting por IP e por conta com atraso progressivo e bloqueio temporário (ex.: `express-rate-limit` + contador por usuário).

### 2. XSS armazenado via JSON não escapado em `<script>` (Baixa) — `xss-ejs-unescaped-json-script`
- **Local:** `views/cliente/novo.ejs:119` (`window.CLIENTE = <%- JSON.stringify(...) %>`) e `views/cliente/estoque.ejs:56`. Nome gravado só com `.trim()` em `src/routes/rep.js:189` / `src/routes/admin.js` (criação de cliente).
- **Principal de menor confiança:** um representante (ou admin) que define o nome do cliente; vítima é esse cliente.
- **Reprodução local:** `nome = </script><script>CLAUDE_XSS=1</script>` → em `/novo` a linha sai crua (`window.CLIENTE = {"nome":"</script><script>...`), enquanto o mesmo nome em `<span class="uname">` sai escapado.
- **Resultado real:** execução de script no navegador do cliente. **Impacto baixo**: o injetor já controla as credenciais daquele cliente, então não há ganho sobre outro principal. As páginas de admin escapam o nome (`views/admin/precos.ejs:44` usa `<%=`), portanto **não** há caminho representante→admin.
- **Menor correção eficaz:** serializar com codificador seguro para `<script>` (escapar `<`, `>`, `&`, U+2028/U+2029) ou usar `<script type="application/json">` + `JSON.parse`; validar `nome` na entrada.

## PRECISA VALIDAÇÃO (leads, sem severidade — dependem do ambiente)

| Lead | Trecho | Bloqueio (fato fora do código) |
|---|---|---|
| Credenciais padrão de admin (admin/admin123) | `src/bootstrap.js:9,14` | ADMIN_SENHA foi definido no 1º deploy? A senha foi trocada? |
| Segredo de sessão padrão + sessão não regenerada | `src/server.js:25`, `src/routes/auth.js:43` | SESSION_SECRET está definido em produção? Há vetor de plantio de cookie? |
| Flag Secure do cookie depende de NODE_ENV | `src/server.js:31` | NODE_ENV=production está definido no Railway? |
| Upload em memória sem limite agregado (~750MB) | `src/routes/cliente.js:39,90,100` | A memória da instância aguenta 30×25MB por pedido? |
| Dependências transitivas do Express com advisories | `package.json:18`, `src/server.js:15,20` | npm audit: 1 crítico (proxy-addr), 2 altos, 1 moderado — exploração concreta não comprovada |

Detalhe e plano de cada lead em `NEEDS-VALIDATION.md`.

### Checagem prioritária para o dono (não destrutiva)
1. **Tentar entrar na produção com `admin` / `admin123`.** Se entrar, trocar a senha agora e definir `ADMIN_SENHA`.
2. **Conferir no Railway** se `SESSION_SECRET` (valor longo e aleatório) e `NODE_ENV=production` estão definidos. Se não, definir e republicar.

## Notas de endurecimento (sem violação de fronteira alcançável)
- **Fixação de sessão:** `src/routes/auth.js:43` não chama `req.session.regenerate()` no login (faz parte do lead do segredo de sessão).
- **Cabeçalhos de segurança:** não há `helmet`/CSP/`X-Content-Type-Options`. Uma CSP ajudaria a conter o XSS do item 2.
- **CSRF:** sem token anti-CSRF, porém `SameSite=Lax` + `httpOnly` mitigam POST entre sites; recomenda-se token se formulários sensíveis passarem a aceitar navegação cross-site.
- **IP de aceite:** `src/routes/cliente.js:169` usa o primeiro valor de `x-forwarded-for`, que o cliente autenticado pode forjar; enfraquece o valor probatório do IP no comprovante (o cliente já está autenticado — impacto informativo).
- **Content-Type de imagem:** `src/imagens.js` serve o mime enviado no upload (restrito a image/* no filtro) — manter a validação.

## Padrões positivos observados
- SQL 100% parametrizado; identificadores dinâmicos só a partir de constantes em whitelist.
- Isolamento por cliente consistente; sem IDOR.
- `operador` barrado de custos/comissões (rotas `exigeAdminFull` + views `isFull`).
- Exclusões sensíveis exigem a senha do admin.

## Cobertura (coverage-ledger.json)
10 unidades: **7 candidatas** (viraram achados: 2 confirmados + 5 precisa-validação) e **3 cobertas** sem achado (IDOR entre clientes; injeção de SQL; escalada operador→admin-completo). Crítico final (passada quick): nenhuma unidade ficou bloqueada; nenhuma rodada adicional de caça foi executada (perfil quick). Sem rodadas anteriores. Áreas adiadas para uma passada **standard**: fluxo completo de pedido/estoque/financeiro, geração de PDFs (pdfkit/pdf-lib) com entrada de usuário, e verificação dinâmica dos leads de ambiente.
