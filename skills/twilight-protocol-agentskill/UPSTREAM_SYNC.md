# Upstream sync (operational, not from upstream repos)

Mirrors in this folder are copied verbatim from:

| Local file | Upstream source |
|---|---|
| `reference-trader.md` | [agentskill `.claude/skills/twilight-trader.md`](https://github.com/twilight-project/agentskill) |
| `reference-strategies.md` | [agentskill `.claude/skills/twilight-strategies.md`](https://github.com/twilight-project/agentskill) |
| `reference-relayer-cli-full.md` | [nyks-wallet `docs/relayer-cli.md`](https://github.com/twilight-project/nyks-wallet/tree/main/docs) |
| `reference-cli-command-rules-full.md` | [nyks-wallet `docs/cli-command-rules.md`](https://github.com/twilight-project/nyks-wallet/tree/main/docs) |
| `reference-order-lifecycle-full.md` | [nyks-wallet `docs/order-lifecycle.md`](https://github.com/twilight-project/nyks-wallet/tree/main/docs) |
| `reference-btc-onboarding-full.md`, `reference-btc-onboarding.md` | [nyks-wallet `docs/btc-onboarding.md`](https://github.com/twilight-project/nyks-wallet/tree/main/docs) |

`SKILL.md` is a **local Cursor index** (frontmatter + links); it is not overwritten by upstream.

## Automation

From the **repository root**:

```bash
node scripts/sync-twilight-skills.mjs --check   # CI: exit 1 if mirrors drift from main branch
node scripts/sync-twilight-skills.mjs --apply   # copy upstream files; refresh SHAs below
```

<!-- SYNC_SHAS_START -->
Commits last verified (UTC 2026-05-03T18:18:19.738Z, apply):

- `twilight-project/agentskill`: `67e1aa17f9917e602000947e18406815fb98f6b8`
- `twilight-project/nyks-wallet`: `1e770b53fae6ccf996a8a7e07c96361bd5e18e27`
<!-- SYNC_SHAS_END -->
