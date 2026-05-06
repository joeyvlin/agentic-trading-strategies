# Web dashboard

Local **Express** server + static UI to:

- **Start / stop** the strategy monitor loop (poll + execute per `configs/agent.monitor.yaml`)
- **Edit** `configs/agent.monitor.yaml` in the browser
- **Run simulation once** (single cycle, forced simulation mode)
- View **estimated P&amp;L metrics**, **persisted transactions**, and **logs**

## Run

From the **repository root**:

```bash
cd dashboard
npm install
# STRATEGY_API_KEY must be in ../.env or the environment
npm start
```

Open **http://127.0.0.1:3847** (default). The API binds to **localhost only** for safety.

## Pages

- **Manual** — operator tools for wallet/session setup, faucet, ZkOS account actions, CEX key management, best-strategy table, position P&L, and trade/venue snapshots. Use this when you want direct, step-by-step control.
- **Automated** — monitor controls and YAML-backed settings (`pollIntervalMs`, strategy filters like CEX venue, risk caps, execution mode, and position auto-close rules). Start/stop the monitor here, run one cycle, and manage automation behavior.
- **Agentic** — twilight-bot controls (spin up / clone / run external bot workflow) for a separate agentic runtime outside the core dashboard monitor loop.

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_PORT` | `3847` | HTTP port |
| `DASHBOARD_HOST` | _(unset)_ | Omit to bind all interfaces (avoids some `localhost` vs `127.0.0.1` / IPv6 issues). Set `127.0.0.1` to restrict to loopback. |
| `DASHBOARD_TOKEN` | _(empty)_ | If set, all `/api/*` routes except `/api/health` require header `x-dashboard-token` |
| `STRATEGY_API_KEY` | — | From repo `.env` (loaded by the monitor service) |
| `CONFIRM_REAL_TRADING` | — | Set via **Twilight wallet → Allow real trading** (writes `.env`) or `YES` manually if yaml `execution.mode` is `real` |
| `MONITOR_RESTART_BACKOFF_MS` | `15000` | After a failed poll cycle (while monitor is still “on”), clear the timer, wait this long, then restart the interval and run an immediate poll. Skipped when the user clicks **Stop monitor**. Minimum enforced in code: `3000`. |

If you set `DASHBOARD_TOKEN`, paste the same value into the **Dashboard token** field in the UI and click **Store** (saved in `localStorage`).

## Data

- `data/transactions.json` — append-only history of executed cycles (simulation or real)
- `data/portfolio.json` — snapshot of open logical trades for risk

Both are **gitignored**; only `data/.gitkeep` is tracked.

## API (for automation)

- `GET /api/health` — no auth
- `GET /api/status`, `POST /api/monitor/start`, `POST /api/monitor/stop`
- `POST /api/simulation/run-once`, `POST /api/run-once`
- `GET /api/config`, `PUT /api/config` with `{ "content": "yaml..." }`
- `GET /api/transactions`, `GET /api/pnl`, `GET /api/logs`
- `POST /api/portfolio/reset` — clears in-memory portfolio snapshot (does not delete `transactions.json`)

## Twilight `relayer-cli` (dashboard UI + API)

The **Twilight relayer** card runs [nyks-wallet](https://github.com/twilight-project/nyks-wallet) `relayer-cli` **on the server** (same process as the dashboard), with `cwd` = repo root so `.env` / `RELAYER_PROGRAM_JSON_PATH` resolve like your terminal. **Wallet encryption password** is entered only in **Twilight wallet** (step 1); faucet and manage sections reuse it.

| Env | Purpose |
|-----|---------|
| `TWILIGHT_RELAYER_CLI` | Path to binary (default: `relayer-cli` on `PATH`) |
| `NYKS_WALLET_ID` / `NYKS_WALLET_PASSPHRASE` | Optional defaults so you need not type them in the browser |
| `RELAYER_ALLOW_DASHBOARD_ZK` | Must be `YES` to enable **ZkOS fund**, **`zkaccount withdraw`**, and **`zkaccount transfer`** from the API/UI |
| `RELAYER_ALLOW_DASHBOARD_ORDERS` | Must be `YES` to enable **order** open/close/cancel from the API/UI |

**Signing:** There is no separate “sign raw tx” endpoint — the CLI signs when executing wallet/order flows. Use **Unlock** / session or env passphrases as in the [agentskill trader reference](https://github.com/twilight-project/agentskill).

Read-only API examples: `GET /api/relayer/meta`, `POST /api/relayer/ping`, `POST /api/relayer/wallet/list`, `POST /api/relayer/market/price`. Wallet commands: `POST /api/relayer/wallet/balance` with optional JSON `{ "walletId", "password" }`. See `dashboard/lib/relayer-routes.mjs` for the full route list.

## Twilight-bot (Agentic tab)

**twilight-bot** ships as a **git submodule** at `external/twilight-bot` (see `.gitmodules`). Clone this repo with submodules:

```bash
git clone --recurse-submodules <this-repo-url>
# or, after a normal clone:
git submodule update --init --depth 1 external/twilight-bot
```

**One-click spin up** (Agentic tab → **Spin up twilight-bot**): runs `git submodule update --init`, `npm install`, `npm run build`, and `npm start` in that directory. Set `TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN=YES` in `.env` first. Leave `TWILIGHT_BOT_REPO_DIR` empty to use the default submodule path (or set it explicitly). The child process inherits the repo `.env` (Strategy API keys, etc.).

| Fallback | When to use |
|----------|-------------|
| **Manual clone** | Point `TWILIGHT_BOT_REPO_DIR` at any checkout. |
| **Dashboard clone** | If you cannot use submodules: `TWILIGHT_BOT_ALLOW_DASHBOARD_CLONE=YES` and **Clone twilight-bot** (https GitHub URLs only). |

twilight-bot is **not** an npm dependency of the dashboard; it runs as a separate Node process (`better-sqlite3` may need local build tools for `npm install`).
