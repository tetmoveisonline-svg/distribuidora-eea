# CLAUDE.md — Preferências do projeto

Orientações para o Claude Code ao trabalhar neste repositório
(`tetmoveisonline-svg/distribuidora-eea` — "Central de Postagem / Dropshipping postagem system").

## Projeto

Sistema de dropshipping/postagem em **Node.js + Express + PostgreSQL**, views em **EJS**.
PDFs com `pdfkit` (comprovante) e `pdf-lib` (etiquetas). Sessão no Postgres
(`connect-pg-simple`). Deploy no **Railway** (push na `main` pode disparar deploy).
Veja `README.md` para a visão geral e como rodar localmente.

## Entrega e publicação

- Depois de **concluir e validar** alterações **explicitamente solicitadas pelo usuário**,
  fazer **commit** e **publicar no GitHub** com **destino final a branch `main`**.
- **Não** entregar apenas um ZIP/patch: o fluxo esperado termina com a mudança no GitHub.
  Se o ambiente exigir uma branch gerenciada, enviar para a branch permitida e abrir um
  **PR para `main`**, informando número, URL e SHA para integração.
- Ao concluir, informar exatamente **o que foi enviado**, **quais testes/validações** rodaram
  e **se a `main` foi atualizada** ou **se ainda falta o merge**.

## Restrições (não fazer)

- **Nunca** fazer `force-push`.
- **Nunca** alterar permissões, proteções de branch, nem segredos/variáveis de ambiente.
- **Nunca** contornar restrições do ambiente — se algo estiver bloqueado, reporte em vez de burlar.

## Segurança e versionamento

- **Nunca versionar** `.env`, credenciais, bancos de dados nem uploads de clientes
  (já cobertos pelo `.gitignore`; mantenha assim).
- Segredos ficam no ambiente (Railway): `SESSION_SECRET` (longo e aleatório),
  `NODE_ENV=production`, `ADMIN_SENHA`, `DATABASE_URL`. Não embutir valores no código.
- Preservar as correções de segurança já aplicadas (rate limit de login, regeneração de
  sessão, escape XSS via `jsonForScript`, cookie `Secure`, sem credenciais/segredo padrão,
  upload em disco temporário, headers de segurança).

## Validação

- Não há framework de testes no projeto. Para mudanças em JS, rodar ao menos `node --check`
  nos arquivos tocados; quando aplicável, renderizar as views EJS afetadas e validar o
  comportamento (ex.: escape de `<`, `>`, `&`, U+2028/U+2029 em `jsonForScript`).
- Ao transferir/aplicar patches de outra sessão, comparar com a `main` atual e aplicar
  **somente o que ainda falta**, preservando alterações posteriores; não reimplementar
  recursos já prontos.
