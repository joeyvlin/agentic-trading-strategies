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

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_PORT` | `3847` | HTTP port |
| `DASHBOARD_HOST` | _(unset)_ | Omit to bind all interfaces (avoids some `localhost` vs `127.0.0.1` / IPv6 issues). Set `127.0.0.1` to restrict to loopback. |
| `DASHBOARD_TOKEN` | _(empty)_ | If set, all `/api/*` routes except `/api/health` require header `x-dashboard-token` |
| `STRATEGY_API_KEY` | — | From repo `.env` (loaded by the monitor service) |
| `CONFIRM_REAL_TRADING` | — | Required `YES` in `.env` if yaml `execution.mode` is `real` |

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

The **Twilight relayer** card runs [nyks-wallet](https://github.com/twilight-project/nyks-wallet) `relayer-cli` **on the server** (same process as the dashboard), with `cwd` = repo root so `.env` / `RELAYER_PROGRAM_JSON_PATH` resolve like your terminal.

| Env | Purpose |
|-----|---------|
| `TWILIGHT_RELAYER_CLI` | Path to binary (default: `relayer-cli` on `PATH`) |
| `NYKS_WALLET_ID` / `NYKS_WALLET_PASSPHRASE` | Optional defaults so you need not type them in the browser |
| `RELAYER_ALLOW_DASHBOARD_ZK` | Must be `YES` to enable **ZkOS fund** and **zkaccount transfer** from the API/UI |
| `RELAYER_ALLOW_DASHBOARD_ORDERS` | Must be `YES` to enable **order** open/close/cancel from the API/UI |

**Signing:** There is no separate “sign raw tx” endpoint — the CLI signs when executing wallet/order flows. Use **Unlock** / session or env passphrases as in the [agentskill trader reference](https://github.com/twilight-project/agentskill).

Read-only API examples: `GET /api/relayer/meta`, `POST /api/relayer/ping`, `POST /api/relayer/wallet/list`, `POST /api/relayer/market/price`. Wallet commands: `POST /api/relayer/wallet/balance` with optional JSON `{ "walletId", "password" }`. See `dashboard/lib/relayer-routes.mjs` for the full route list.
