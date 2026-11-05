# Detalhe dos achados confirmados

Observação: nenhum achado confirmado é de severidade média-alta-crítica que exija reprodução contra ambiente real. Os dois confirmados abaixo (uma média, uma baixa) foram reproduzidos localmente em sandbox isolado com dados fictícios. Detalhe por completude.

---

## 1. Login sem limite de tentativas — Média — `login-no-rate-limit`

**Trace (fonte):**
- entrypoint — `src/routes/auth.js:25` — POST /login aceita login/senha arbitrários sem throttling.
- sink — `src/routes/auth.js:38` — `bcrypt.compare(...)`; falha retorna 401 e a próxima tentativa é aceita de imediato.

**Evidência:**
- `src/routes/auth.js:33` — SELECT do usuário por login; nenhum estado de tentativas é consultado.
- `src/server.js:67` — nenhum middleware de rate limit registrado (grep por rate-limit/lockout/tentativas/captcha: sem ocorrências).

**Atacante / principal:** não autenticado, na rede.

**Reprodução local (interface nativa HTTP, dados fictícios):**
```
for i in 1..6: POST /login (login=admin, senha=errada$i)   => HTTP 401 (cada)
POST /login (login=admin, senha=admin123)                  => HTTP 302  (imediato)
```
**Resultado observado:** seis falhas seguidas sem atraso/bloqueio, e a senha correta entra logo em seguida — adivinhação online ilimitada.

**Invariante de segurança:** tentativas malsucedidas devem ser limitadas/atrasadas por IP e por conta.

**Correção (menor eficaz) + regressão:** aplicar `express-rate-limit` na rota de login e um contador de tentativas por conta com bloqueio temporário; teste de regressão que verifica HTTP 429/bloqueio após N falhas dentro da janela.

**Contenção:** bcrypt eleva o custo por tentativa; o impacto final depende da força das senhas (ver lead de senha padrão do admin).

---

## 2. XSS armazenado via JSON não escapado em `<script>` — Baixa — `xss-ejs-unescaped-json-script`

**Trace (fonte):**
- entrypoint — `src/routes/rep.js:189` — representante define `nome` do cliente só com `.trim()`.
- propagation — `src/routes/cliente.js:83` — `clienteNome` (de `clientes.nome`) vai para a view.
- sink — `views/cliente/novo.ejs:119` — `window.CLIENTE = <%- JSON.stringify({nome: clienteNome, ...}) %>`.

**Evidência:**
- `views/cliente/novo.ejs:119` — saída crua do EJS (`<%-`) em contexto de `<script>`.
- `views/cliente/estoque.ejs:56` — `var dados = <%- JSON.stringify(produtos) %>` (mesmo padrão).

**Atacante / principal:** admin ou representante que cria/edita a conta do cliente; vítima é o cliente.

**Reprodução local:**
```
POST /admin/clientes (ou /rep/clientes)  nome=</script><script>CLAUDE_XSS=1</script>
login como o cliente -> GET /novo
```
**Resultado observado:** `window.CLIENTE = {"nome":"</script><script>CLAUDE_XSS=1</script>",...}` (cru, quebra o `<script>`), enquanto `<span class="uname">` exibe o mesmo nome escapado (`&lt;/script&gt;...`).

**Invariante de segurança:** dados influenciados por usuário dentro de `<script>` inline devem passar por codificador seguro para contexto de script.

**Contenção / por que Baixa:** o injetor (admin/representante) já possui as credenciais do cliente, então não há ganho sobre outro principal. Checado e **descartado** o caminho de escalonamento para admin: `views/admin/precos.ejs:44` usa `<%=` (escapado).

**Correção (menor eficaz) + regressão:** trocar `<%- JSON.stringify(x) %>` por um codificador que escape `<`, `>`, `&`, U+2028/U+2029 (ou `<script type="application/json">` + `JSON.parse`), e normalizar/validar `nome` na entrada; teste que renderiza um nome com `</script>` e confirma que a saída não contém a sequência crua.
