---
name: twilight-protocol-agentskill
description: Provides Twilight Protocol trading context — relayer-cli (wallet, ZkOS, orders, market) and the Twilight Strategy API (live strategies, market data, custom runs, pool impact). Use when working with Twilight Protocol, inverse perpetuals, twilight-strategy-tester, relayer-cli, Strategy API, hedging, funding arbitrage, or delta-neutral strategies across Twilight, Binance, and Bybit.
---

# Twilight Protocol (agentskill)

Upstream sources:
- Strategy API docs: [twilight-project/agentskill](https://github.com/twilight-project/agentskill)
- Relayer CLI + onboarding docs: [twilight-project/nyks-wallet/docs](https://github.com/twilight-project/nyks-wallet/tree/main/docs)

## Which reference to read

| User goal | Read |
|-----------|------|
| CLI trading, wallet, ZkOS, `relayer-cli` | [reference-trader.md](reference-trader.md) |
| BTC onboarding / mainnet deposits & withdrawals | [reference-btc-onboarding.md](reference-btc-onboarding.md) |
| Strategy API, curls, filters, categories | [reference-strategies.md](reference-strategies.md) |

### Full upstream mirrors (verbatim from nyks-wallet/docs)

- [reference-relayer-cli-full.md](reference-relayer-cli-full.md)
- [reference-cli-command-rules-full.md](reference-cli-command-rules-full.md)
- [reference-order-lifecycle-full.md](reference-order-lifecycle-full.md)
- [reference-btc-onboarding-full.md](reference-btc-onboarding-full.md)

## Key concepts (both flows)

- **Twilight**: 0% trading fees and 0% funding vs centralized venues — strategies often exploit that spread.
- **Inverse perpetuals**: margin in BTC (sats); PnL in sats.
- **ZkOS accounts**: Coin (idle) / Memo (order active). After a settled close, **`unlock-close-order`** (if needed) then **`zkaccount transfer --account-index <index>`** before a new open, except unfilled cancelled limits.
- **Wallet vs ZkOS**: Create/import the **NYKS wallet** first; the first **`zkaccount fund`** moves on-chain sats into a ZkOS account (no separate “create empty ZkOS” step). See [reference-trader.md](reference-trader.md).
- **Limits**: max leverage 50x; max position ~20% of pool equity (confirm via `market market-stats` or API).

## Mainnet endpoints

| Service | URL |
|---------|-----|
| LCD | `https://lcd.twilight.org` |
| RPC | `https://rpc.twilight.org` |
| ZkOS Server | `https://zkserver.twilight.org` |
| Relayer API | `https://api.ephemeral.fi/api` |
| Strategy API | `https://strategy.lunarpunk.xyz` |
| Explorer | `https://explorer.twilight.org` |

## Strategy API (minimal)

- **Base**: `https://strategy.lunarpunk.xyz`
- **Auth** (except `/api/health`): header `x-api-key: 123hEll@he` or `?api_key=...`
- **Examples**: `GET /api/market`, `GET /api/strategies?profitable=true&limit=5`, `POST /api/strategies/run`, `POST /api/impact`

Full endpoints, filters, and categories: [reference-strategies.md](reference-strategies.md).

## Relayer CLI (minimal)

- Binary: `relayer-cli` from [nyks-wallet](https://github.com/twilight-project/nyks-wallet) (build produces `target/release/relayer-cli`).
- Typical flow: `market price` / `market market-stats` → `wallet balance` → `zkaccount fund` → `order open-trade` → `order close-trade` → `order unlock-close-order` (when applicable) → `zkaccount transfer --account-index <index>`.

Full commands, `.env` samples, and constraints: [reference-trader.md](reference-trader.md).  
Mainnet BTC onboarding (register/deposit/withdraw): [reference-btc-onboarding.md](reference-btc-onboarding.md).
