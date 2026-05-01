# twilight-strategy-monitor

Polls the **Twilight Strategy API**, applies **risk limits** from `configs/agent.monitor.yaml`, then either:

- **simulation** — logs the intended trade and tracks a virtual portfolio (no exchange or relayer calls), or  
- **real** — places a **CEX** market order via [ccxt](https://github.com/ccxt/ccxt) (Binance USDM or Bybit) when API keys are set; **Twilight** execution uses `relayer-cli` only if you explicitly enable it.

## Prerequisites

- **Node.js 18+**
- Strategy API key (see [twilight-project/agentskill](https://github.com/twilight-project/agentskill) README)

## Setup

From the **repository root** (`agentic-trading-strategies/`):

```bash
cp configs/env.example .env
# Edit .env — at minimum set STRATEGY_API_KEY
```

Install dependencies:

```bash
cd agents/twilight-strategy-monitor
npm install
```

Ensure `configs/agent.monitor.yaml` exists (committed default) or copy from `configs/agent.monitor.example.yaml`.

## Run (simulation)

Simulation does **not** send orders. It still calls the live Strategy API for signals.

```bash
cd agents/twilight-strategy-monitor
# from .env or inline:
export STRATEGY_API_KEY="your_key"
npm run start:sim -- --once
```

- Omit `--once` to poll every `pollIntervalMs` (default 60000).
- Set `pollIntervalMs: 0` in `configs/agent.monitor.yaml` for a single run when not passing `--once`.

## Run (real execution)

**Warning:** real mode can place **real exchange orders** and optionally invoke **relayer-cli** for Twilight.

1. Set keys in `.env` (Binance and/or Bybit as needed for the strategy’s CEX leg).
2. Acknowledge risk:

```bash
export CONFIRM_REAL_TRADING=YES
export AGENT_MODE=real
export STRATEGY_API_KEY="your_key"
```

3. Start:

```bash
cd agents/twilight-strategy-monitor
npm run start:real -- --once
```

### Twilight (`relayer-cli`)

In real mode the Twilight leg runs when **real trading is confirmed** (`CONFIRM_REAL_TRADING=YES`) or `ALLOW_TWILIGHT_CLI_EXECUTION=1`; use `ALLOW_TWILIGHT_CLI_EXECUTION=0` to disable. Point `TWILIGHT_RELAYER_CLI` at the binary and supply wallet to the relayer (env or dashboard session on manual runs).

### Testnet

```bash
export BINANCE_USE_TESTNET=1
# and/or
export BYBIT_USE_TESTNET=1
```

## Configuration

| Source | Purpose |
|--------|---------|
| `configs/agent.monitor.yaml` | Poll interval, strategy filters (`/api/strategies` query params), risk caps |
| `.env` | Secrets, `AGENT_MODE`, `CONFIRM_REAL_TRADING`, exchange keys |

Check whether local Strategy API defaults still match upstream skill docs:

```bash
npm run check:upstream
```

Override config path:

```bash
export AGENT_CONFIG_PATH=/path/to/custom.monitor.yaml
```

## How it picks trades

Each cycle:

1. Fetches `/api/market` and `/api/strategies` with your filters.
2. Sorts by **APY** and takes the **top** strategy.
3. Runs risk checks (total / per-venue notional, concurrent trades, daily loss).
4. Executes in **simulation** or **real** mode.

## Web dashboard

A local browser UI (start/stop monitor, edit config, simulation, P&amp;L + transaction history) lives in [`dashboard/`](../../dashboard/). Run `cd dashboard && npm install && npm start` and open http://127.0.0.1:3847.

## Related docs

- [`docs/architecture.md`](../../docs/architecture.md)
- [`docs/security.md`](../../docs/security.md)
- [`skills/twilight-protocol-agentskill/`](../../skills/twilight-protocol-agentskill/)
