# Agentic Trading Strategies

A collection of **AI agents** for systematic trading. Agents combine market signals, risk controls, and execution across venues.

## Phase 1: Twilight multi-venue agents

The first agents use **[Twilight Protocol](https://twilight.rest)** alongside centralized exchanges (e.g. **Binance**, **Bybit**) to monitor profitable strategies and coordinate execution—often delta-neutral or funding-style setups where Twilight’s fee and funding profile differs from other venues.

### References in this repo

| Path | Purpose |
|------|---------|
| [`skills/twilight-protocol-agentskill/`](skills/twilight-protocol-agentskill/) | Cursor-oriented skill bundle: Strategy API + `relayer-cli` context (synced from [twilight-project/agentskill](https://github.com/twilight-project/agentskill)) |
| [`agents/twilight-strategy-monitor/`](agents/twilight-strategy-monitor/) | Placeholder for the first monitoring + execution agent |
| [`docs/`](docs/) | Architecture, operations, and safety notes |
| [`configs/`](configs/) | Non-secret configuration templates |

### Using the Twilight skill in Cursor

Copy or symlink the skill into your Cursor skills directory so the agent has full protocol context:

```bash
ln -s "$(pwd)/skills/twilight-protocol-agentskill" ~/.cursor/skills/twilight-protocol-agentskill
```

Or copy the folder to `~/.cursor/skills/twilight-protocol-agentskill`.

## Repository layout

```
agents/          # One subdirectory per agent (code, prompts, runbooks)
configs/         # Example env and non-secret defaults (see env.example)
docs/            # Architecture and operational documentation
skills/          # Bundled AI skills (Twilight Protocol)
```

## Safety

- **Do not commit** API keys, wallet mnemonics, or exchange secrets. Use `configs/env.example` as a template and keep real values in `.env` (gitignored) or your secret manager.
- Treat public example API keys in upstream docs as **non-production**; use keys you control for real trading.

## License

See [LICENSE](LICENSE).
