# BotArmor audit — GitHub Action

Crash-test your chatbot or AI agent on every push and pull request. BotArmor attacks the deployed agent on up to 12 levels (fake manager, angry customer, prompt injection, role-play, phishing, AI disclosure under the EU AI Act, invented facts, and more), 5 adaptive sessions each, plus level 13 for agents with tools.

The action fails the job when the score is too low or when a level breaks at the severity you choose. It also writes the results to the Job Summary as a table and gives you a link to the signed, publicly verifiable report.

It is a thin wrapper over the [BotArmor API](https://app.botarmor.eu/api/v1/openapi.yaml), the same one the Make app, the n8n node and the MCP server use.

## Quick start

1. Create an API key in the [BotArmor dashboard](https://app.botarmor.eu/app/), tab **API**. Save it as the repository secret `BOTARMOR_API_KEY`.
2. If your staging bot needs a token, save it as `STAGING_BOT_TOKEN`.
3. Add `.github/workflows/botarmor.yml`:

```yaml
name: BotArmor audit
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  pull-requests: write   # for the PR comment

concurrency:
  group: botarmor-${{ github.ref }}
  cancel-in-progress: false

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4

      - name: Crash-test the staging agent
        id: botarmor
        uses: sidorenkav-collab/botarmor-audit-action@v1
        with:
          api-key: ${{ secrets.BOTARMOR_API_KEY }}
          target-url: https://staging.example.com/v1/chat/completions
          target-type: openai-compatible
          target-headers: |
            Authorization: Bearer ${{ secrets.STAGING_BOT_TOKEN }}
          system-prompt-file: prompts/support-agent.md
          authorization-confirmed: "true"   # you own this bot
          min-score: 75
          fail-on: high

      - name: Comment the result on the pull request
        if: always() && github.event_name == 'pull_request' && steps.botarmor.outputs.audit-id != ''
        uses: actions/github-script@v7
        env:
          SCORE: ${{ steps.botarmor.outputs.score }}
          GRADE: ${{ steps.botarmor.outputs.grade }}
          PASSED: ${{ steps.botarmor.outputs.passed }}
          REPORT: ${{ steps.botarmor.outputs.report-url }}
          AUDIT: ${{ steps.botarmor.outputs.audit-id }}
        with:
          script: |
            const { SCORE, GRADE, PASSED, REPORT, AUDIT } = process.env;
            const icon = PASSED === 'true' ? '✅' : '❌';
            await github.rest.issues.createComment({
              owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number,
              body: `${icon} **BotArmor audit ${AUDIT}**: grade **${GRADE || '-'}** (${SCORE || '-'}/100). ` +
                    `[Signed report](${REPORT}) · details in the job summary.`,
            });
```

Two things about this workflow:

- **Concurrency.** A BotArmor account runs one audit at a time. If another job holds it, the action waits for it rather than failing.
- **Re-runs.** Each run attempt starts one audit, with an idempotency key, so a retried request is never billed twice.

**Prompt-only mode.** Without `target-url`, BotArmor plays the system prompt from your repository on its own model. It needs no deployed bot and no authorization, and makes a good gate on changes to the prompt file. The result is an estimate; a live audit of the deployed agent is the reliable verdict.

```yaml
      - uses: sidorenkav-collab/botarmor-audit-action@v1
        with:
          api-key: ${{ secrets.BOTARMOR_API_KEY }}
          system-prompt-file: prompts/support-agent.md
          fail-on: critical
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | — | BotArmor API key, from secrets. |
| `target-url` | empty | Public https URL of the deployed agent. Empty = prompt-only audit. |
| `target-type` | `webhook` with a URL, `prompt` without | `openai-compatible` (chat completions), `webhook` (any JSON endpoint) or `prompt`. |
| `target-headers` | empty | JSON or one `Name: value` per line. A credential header is stored encrypted by BotArmor; all values are masked in logs. |
| `target-model` | `default` | Model name sent to an openai-compatible target. |
| `system-prompt-file` / `system-prompt` | — | The agent's instructions. They are the rulebook the judge checks answers against, and what prompt mode plays. |
| `levels` | all | Comma-separated subset: `logic, toxic, hacker, lawyer, multilang, loop, roleplay, phishing, ethics, burst, disclosure, facts, agency`. |
| `min-score` | `0` | Fail below this overall score (0–100). |
| `fail-on` | `high` | Fail when a level breaks at `critical`, `high` or higher, `any` severity, or `none`. |
| `authorization-confirmed` | `false` | Must be `"true"` for a live audit: you own the bot or hold the owner's written permission. BotArmor never tests third-party bots. |
| `name`, `lang` | repo name, `en` | Report name and language (`fr`, `en`, `de`, `es`, `ru`). |
| `timeout-minutes` | `40` | How long to wait. A full audit takes 5–20 minutes. |

## Outputs

`score`, `grade`, `audit-id`, `report-url` (the public verification page of the signed report) and `passed` (`"true"`/`"false"`).

## Planned: start the agent inside CI

A later version will audit an agent started inside the job (for example `docker compose up` on the runner), without a staging deployment. BotArmor's servers cannot reach the runner's localhost. The plan is a short-lived public tunnel opened by the action, plus a per-run token that BotArmor must present.

Until then:

- audit a deployed staging URL, or
- use prompt-only mode on the prompt file.

## Notes

- Each audit uses one credit of your BotArmor plan. A retest after a fix is included.
- Reports are point-in-time test attestations for one prompt version, not certifications.
- MIT licence. BotArmor AI is a brand of Rhone IA (Andrii Sydorenko EI), France.
