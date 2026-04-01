# Architecture (overview)

This document describes the intended shape of agents in this repository. Concrete implementations will land under `agents/<name>/`.

## Layers

1. **Signal** — Ingest strategy and market data (e.g. Twilight Strategy API: `/api/strategies`, `/api/market`). Apply filters (profitability, category, risk, minimum APY) and deduplicate alerts.
2. **Decision** — Map signals to actionable intents (size, side, venue) within per-agent risk limits (max notional, max leverage, cooldowns).
3. **Execution** — Place orders on **Twilight** (typically via `relayer-cli` or the Ephemeral API) and on **Binance/Bybit** via their APIs. Use a single logical **trade id** for correlation and logs.
4. **Reconciliation** — Confirm fills (or partials), handle failures (retry policy, hedge, or flatten), and record P&amp;L assumptions vs. actuals where possible.

## Twilight-specific constraints

- **ZkOS account rotation** after a settled close before opening a new position on the same account path (see bundled skill `reference-trader.md`).
- **Pool and leverage limits** — Confirm max position vs. pool (e.g. via `market market-stats` or API).

## Cross-venue coordination

- Time-align legs where latency matters; define **slippage** and **abandon** rules if one leg fails.
- Prefer **idempotent** client order IDs on exchanges that support them.

For API and CLI specifics, see [`skills/twilight-protocol-agentskill/`](../skills/twilight-protocol-agentskill/).
