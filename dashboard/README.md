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
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address (avoid `0.0.0.0` unless you know the risk) |
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
