# Agentic Trading Strategies

A collection of **AI agents** for systematic trading. Agents combine market signals, risk controls, and execution across venues.

## Quick start (Twilight strategy monitor)

1. Clone the repo and copy environment template:

   ```bash
   cp configs/env.example .env
   ```

2. Set `STRATEGY_API_KEY` in `.env` (see [twilight-project/agentskill](https://github.com/twilight-project/agentskill)).

3. Install and run **simulation** (no real orders, still uses live Strategy API data):

   ```bash
   cd agents/twilight-strategy-monitor
   npm install
   npm run start:sim -- --once
   ```

See **[agents/twilight-strategy-monitor/README.md](agents/twilight-strategy-monitor/README.md)** for **real execution** mode, exchange keys, and `relayer-cli` options.

### Web dashboard

Browser UI to start/stop the monitor, edit YAML config, run **`Run simulation once`**, and inspect transactions / estimated P&amp;L:

```bash
cd dashboard
npm install
npm start
```

Then open **http://127.0.0.1:3847**. Details: **[dashboard/README.md](dashboard/README.md)**.

## Phase 1: Twilight multi-venue agents

The first agents use **[Twilight Protocol](https://twilight.rest)** alongside centralized exchanges (e.g. **Binance**, **Bybit**) to monitor profitable strategies and coordinate execution—often delta-neutral or funding-style setups where Twilight’s fee and funding profile differs from other venues.

### References in this repo

| Path | Purpose |
|------|---------|
| [`skills/twilight-protocol-agentskill/`](skills/twilight-protocol-agentskill/) | Cursor-oriented skill bundle: Strategy API + `relayer-cli` context (synced from [twilight-project/agentskill](https://github.com/twilight-project/agentskill)) |
| [`agents/twilight-strategy-monitor/`](agents/twilight-strategy-monitor/) | Node.js monitor: Strategy API polling, risk limits, simulation vs. real execution |
| [`docs/`](docs/) | Architecture, operations, and safety notes |
| [`configs/`](configs/) | `agent.monitor.yaml`, `env.example` |

### Using the Twilight skill in Cursor

Copy or symlink the skill into your Cursor skills directory so the agent has full protocol context:

```bash
ln -s "$(pwd)/skills/twilight-protocol-agentskill" ~/.cursor/skills/twilight-protocol-agentskill
```

Or copy the folder to `~/.cursor/skills/twilight-protocol-agentskill`.

## Repository layout

```
agents/          # One subdirectory per agent (code, prompts, runbooks)
configs/         # agent.monitor.yaml (defaults) and env.example
docs/            # Architecture and operational documentation
skills/          # Bundled AI skills (Twilight Protocol)
```

## Safety

- **Do not commit** API keys, wallet mnemonics, or exchange secrets. Use `configs/env.example` as a template and keep real values in `.env` (gitignored) or your secret manager.
- Treat public example API keys in upstream docs as **non-production**; use keys you control for real trading.
- Real trading requires `CONFIRM_REAL_TRADING=YES` and `AGENT_MODE=real`; see the agent README.

## License

See [LICENSE](LICENSE).
