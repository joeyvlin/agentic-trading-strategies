# twilight-strategy-monitor

**Status:** scaffold — implementation pending.

## Intended behavior

1. Poll or subscribe (per available APIs) to the Twilight Strategy API for strategies matching configurable filters (`profitable`, `category`, `risk`, `minApy`, `limit`).
2. Optionally cross-check live market data (`/api/market`).
3. When thresholds are met, orchestrate execution on **Twilight** and a **second venue** (Binance/Bybit) according to the strategy shape and agent risk limits.

## References

- Skill bundle: [`skills/twilight-protocol-agentskill/`](../../skills/twilight-protocol-agentskill/)
- Upstream: [twilight-project/agentskill](https://github.com/twilight-project/agentskill)

## Next steps (implementation)

- Choose runtime (Node, Python, or Rust) and add dependency manifest in this folder.
- Implement configuration from `configs/env.example` and agent-specific YAML/JSON if needed.
- Add a dry-run mode that logs intended orders without submitting.
