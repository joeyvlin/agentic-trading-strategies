# CLAUDE.md — Agentic Trading Strategies

Quick orientation for agents. Read this before touching code.

## What this repo is

A Node.js **web dashboard** + **strategy monitor agent** for systematic trading on [Twilight Protocol](https://twilight.rest) (a ZkOS BTC exchange) with CEX hedging legs (Binance/Bybit via ccxt). The dashboard is the primary surface being developed.

## Repo layout

```
dashboard/          # Express server + single-page UI (active development)
  server.mjs        # Entry point — wires all route modules, runs on port 3847
  lib/              # Backend modules (see below)
  public/           # Static frontend: app.js (vanilla JS), index.html, output.css
  src/style.css     # Tailwind source (built → public/output.css)
agents/
  twilight-strategy-monitor/   # Node.js polling agent (strategy API → risk checks → ccxt execution)
configs/
  agent.monitor.yaml           # Agent config: poll interval, risk limits, execution mode
  env.example                  # Template for .env at repo root
external/twilight-bot/         # Git submodule: separate agentic bot process
skills/twilight-protocol-agentskill/  # Upstream skill docs (Twilight Strategy API + relayer-cli)
data/               # Runtime data files (gitignored except .gitkeep)
  transactions.json, portfolio.json, positions.json, exchange-keys.json
```

## Dashboard architecture

### Backend — `dashboard/lib/` modules

| Module | Role |
|--------|------|
| `monitor-service.mjs` | Wraps `twilight-strategy-monitor` agent: start/stop polling loop, hold logs + P&L |
| `agent-settings.mjs` / `agent-settings-routes.mjs` | Read/write `configs/agent.monitor.yaml` via API |
| `persistence.mjs` | `data/transactions.json` and `data/portfolio.json` read/write; `getRepoRoot()` |
| `position-ledger.mjs` | In-memory open position tracking; realized/unrealized P&L calc |
| `position-close-service.mjs` | Orchestrates full position close (Twilight + CEX legs) |
| `position-auto-close.mjs` | Periodic pass: closes positions when strategy APY ≤ 0 |
| `trade-desk.mjs` | Snapshot of open trades across all venues for the UI |
| `relayer-cli.mjs` | Spawns `relayer-cli` binary (nyks-wallet); `sanitizeString` for all user input |
| `relayer-routes.mjs` | REST routes that proxy relayer-cli commands to the browser |
| `relayer-parse.mjs` | Parse relayer-cli stdout (wallet balance, address, wallet list) |
| `env-store.mjs` / `env-routes.mjs` / `env-catalog.mjs` | Read/write/mask `.env` at repo root via API |
| `exchange-keys-store.mjs` | CEX API keys: load, save (masked for client), validate last-status |
| `twilight-bot-process.mjs` | Spawn/stop/command the `twilight-bot` child process |
| `twilight-bot-routes.mjs` | REST routes for twilight-bot control and log streaming |
| `twilight-bot-spinup.mjs` | One-click: `git submodule update` → `npm install` → `npm run build` → `npm start` |
| `twilight-bot-repo.mjs` | Optional dashboard-side `git clone` of twilight-bot |
| `twilight-bot-auto-close.mjs` | Periodic pass: close twilight-bot positions with APY ≤ 0 |
| `twilight-faucet.mjs` | Request testnet NYKS tokens / test sats from faucet |
| `cex-flatten.mjs` | Flatten (close) a CEX position via ccxt |

### Frontend — `dashboard/public/app.js`

Vanilla JS single-page app, no build step. Three tabs controlled by `initDeskTabs()`:

- **Manual** (`tab-desk-manual`) — wallet setup, ZkOS account actions, faucet, CEX key management, best-strategy table, position P&L, trade/venue snapshots. Direct operator control.
- **Automated** (`tab-desk-automated`) — monitor start/stop, YAML config editor, run-once simulation, auto-close rules. `sec-agent` / `sec-advanced` section IDs.
- **Agentic** (`tab-desk-agentic`) — twilight-bot spin-up, live/paper mode toggles, run-command box that maps commands to bot HTTP endpoints.

Section collapse state persisted in `localStorage` (`dashboardCollapsedSectionsV1`). Active tab persisted in `localStorage` (`dashboardDeskTabV1`).

### Key env vars

| Var | Purpose |
|-----|---------|
| `STRATEGY_API_KEY` | Twilight Strategy API key (required) |
| `DASHBOARD_PORT` | HTTP port (default: `3847`) |
| `CONFIRM_REAL_TRADING` | Must be `YES` when `execution.mode: real` |
| `TWILIGHT_RELAYER_CLI` | Path to relayer-cli binary |
| `RELAYER_ALLOW_DASHBOARD_ZK` | `YES` to enable ZkOS fund/withdraw/transfer from UI |
| `RELAYER_ALLOW_DASHBOARD_ORDERS` | `YES` to enable order open/close/cancel from UI |
| `TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN` | `YES` to enable one-click twilight-bot spin-up |

### Data flow summary

```
Browser → GET/POST /api/* → server.mjs → lib/* → monitor-service / relayer-cli / ccxt / position-ledger
                                                 → data/transactions.json, data/portfolio.json
Monitor loop → twilight-strategy-monitor agent → Twilight Strategy API + ccxt (CEX)
twilight-bot (child process) → its own HTTP port → proxied via /api/twilight-bot/*
```

## Development

```bash
# Dashboard (from repo root)
cd dashboard && npm install && npm start   # http://127.0.0.1:3847

# Rebuild Tailwind CSS (only needed when editing src/style.css)
npm run build:css

# Tests
npm test          # API integration tests (node --test)
npm run test:e2e  # Playwright e2e
```

## Claude Code skills

| Command | File | Purpose |
|---------|------|---------|
| `/setup-external-deps` | `.claude/commands/setup-external-deps.md` | Guided, state-aware setup for the `external/twilight-bot` submodule and `relayer-cli` binary — run this after a fresh clone or when either dependency is missing |

## Key constraints

- All user-supplied strings passed to `relayer-cli` must go through `sanitizeString()` (dashboard/lib/relayer-cli.mjs).
- `RELAYER_ALLOW_DASHBOARD_ZK` and `RELAYER_ALLOW_DASHBOARD_ORDERS` are explicit opt-ins — never enable them by default.
- Never commit `.env`, `data/*.json`, or `external/twilight-bot` changes to this repo's history.
- twilight-bot is a **submodule** (`external/twilight-bot`), not an npm dependency. It runs as a separate process.
