# Política de segurança

## Reportando uma vulnerabilidade

Use **[Security → Report a vulnerability](https://github.com/Danil0ws/agentic-teams-web/security/advisories/new)** (GitHub Private Advisory). Não abra issue pública para falha de segurança.

Inclua: versão/commit, passos de reprodução, impacto e, se houver, o PoC mínimo. Retorno em até **5 dias úteis**; correção coordenada antes de qualquer divulgação pública.

## Versões suportadas

Projeto em `0.x`: apenas a `main` recebe correção de segurança.

## Superfície que interessa

| Área | O que é tratado como falha |
| --- | --- |
| `POST /api/messages` | Aceitar Activity sem token válido (ou com `aud`/`serviceurl` divergentes) quando `BOT_SKIP_AUTH=0`; bypass da verificação RS256 (`alg: none`, chave injetada) |
| `src/agent/nodes.ts` | Vazar segredo em resposta ou chamado (falha de `redactSecrets`); executar instrução embutida na mensagem do usuário que altere regra de negócio |
| `src/llm/provider.ts` | Injeção de prompt que faça o agente inventar preço/SLA fora do catálogo |
| `src/server/http.ts` | Leitura de arquivo fora do previsto, DoS trivial por payload, rota que execute comando |
| `src/memory/store.ts` | Injeção de SQL (as consultas são parametrizadas — regressão é falha) |
| Configuração | `BOT_SKIP_AUTH=1` ou `POST /api/simulate` expostos na internet: documentado como **uso indevido de implantação**, não vulnerabilidade do código |

## O que está fora de escopo

- **Adapter `teams-web`**: ele automatiza a interface do Teams Web, o que contraria os termos de uso da Microsoft para uso não assistido/em massa. Relatar isso não é falha do projeto — a postura está declarada no [README](README.md#aviso-legal) e o caminho suportado é o `botframework`.
- Engenharia social, phishing, ataque físico.
- Falha que exija credenciais válidas do seu próprio tenant Azure.
- Ausência de limite de requisições no servidor local (use um proxy na frente).

## Recomendações de implantação

Antes de expor o serviço:

- [ ] `BOT_SKIP_AUTH=0` (validação de JWT ligada) e `BOT_APP_ID`/`BOT_APP_SECRET` fora do repositório (Key Vault, SSM, secret do orquestrador).
- [ ] `SIMULATE_DISABLED=1` para desligar `POST /api/simulate`.
- [ ] TLS terminando em proxy reverso; `HOST=127.0.0.1` quando não houver proxy.
- [ ] `DB_PATH` em volume persistente com permissão restrita (contém texto de conversas — dado pessoal).
- [ ] `/health` e `/api/metrics` monitorados; `counters.errors` é o sinal de falha do agente.
- [ ] Rotação do client secret do Azure Bot antes do vencimento.
