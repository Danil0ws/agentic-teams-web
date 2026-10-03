# Contribuindo

Obrigado pelo interesse. Este projeto é pequeno de propósito — a contribuição mais útil costuma ser **dados, regras e um transport novo**, não mais camadas.

## Antes de abrir PR

```bash
git clone https://github.com/Danil0ws/agentic-teams-web
cd agentic-teams-web
npm install          # opcional: Playwright só é necessário para o adapter teams-web
npm test             # 47 testes, sem rede e sem chave — precisa passar 100%
```

Nada de build: o Node executa o `.ts` direto (`node src/cli/serve.ts`). Se o seu Node for < 22.6, o projeto não roda — veja `engines` no `package.json`.

## Onde cada mudança encaixa

| Quer mudar | Arquivo | Regra |
| --- | --- | --- |
| Domínio do negócio (produtos, preços, políticas) | `data/catalog.csv`, `data/faq.md` | Preço **só** vem do catálogo. Nunca peça ao LLM para calcular valor. |
| Como o agente decide/responde | `src/agent/nodes.ts` (+ `graph.ts` para o fluxo) | Nó novo entra com teste em `tests/agent.test.ts` e um caso no trace. |
| Novo canal (Slack, WhatsApp, web chat) | `src/adapters/<canal>/` | Implemente `Channel` de `src/adapters/types.ts` e normalize para `InboundMessage`. O cérebro **não** deve ser tocado. |
| Nova ferramenta (CRM, ERP, tickets) | `src/tools/` | Pura e testável: entrada texto/objeto, saída objeto. Sem I/O escondido. |
| LLM diferente | `src/llm/provider.ts` | Qualquer endpoint `/chat/completions` já funciona. Provider novo tem que degradar para o caminho determinístico quando falhar. |
| Painel | `src/server/dashboard.html` | HTML + `fetch`, sem build. Verifique em 1440px, 390px e 320px. |

## Regras de ouro

1. **Determinismo no caminho padrão.** `LLM_PROVIDER=offline` tem que continuar respondendo corretamente. O LLM é camada de linguagem, não de regra.
2. **Nada de dependência obrigatória nova.** `node:sqlite`, `node:http`, `node:crypto` e o TypeScript nativo cobrem quase tudo. Dependência opcional entra em `optionalDependencies` e tem que degradar com mensagem clara.
3. **Sintaxe compatível com type stripping.** Sem `enum`, sem `namespace`, sem *parameter properties* (`constructor(private x)`); imports sempre com extensão (`./x.ts`). Detalhes na skill `node-native-typescript`.
4. **Teste junto.** Lógica com branch, loop ou dinheiro exige pelo menos um teste (`node:test`, `assert`). Teste que depende de rede, chave ou Teams real não entra.
5. **Segredo nunca sai.** Resposta e chamado passam por `redactSecrets`. Se você adicionar uma saída nova (e-mail, webhook, comentário), passe por lá também.

## Commits e PRs

- [Conventional Commits](https://www.conventionalcommits.org/pt-br/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Um assunto por PR. Descreva **o comportamento verificado** (comando rodado e saída), não a intenção.
- PR que muda comportamento atualiza `CHANGELOG.md` (pt-BR) e `REGISTRO.md` quando envolve decisão.

## Ambiente de desenvolvimento

```bash
npm start                          # servidor + painel em http://127.0.0.1:3110
npm run chat -- "sua pergunta"     # conversa única, sem Teams
npm run bot:dev                    # webhook em modo dev, com o curl pronto
TEAMS_WEB_ENABLE=1 TEAMS_WEB_HEADLESS=0 npm run teams-web   # navegador (primeira vez: login manual)
```

`.env` é local e ignorado pelo git — use `.env.example` como referência.

## Licença

Ao contribuir você concorda em licenciar sua contribuição sob a [MIT](LICENSE).
