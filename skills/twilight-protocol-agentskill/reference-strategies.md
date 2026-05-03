---
name: twilight-strategies
description: |
  Query and run trading strategies on the Twilight Strategy API. Use when the
  user asks about hedging, funding arbitrage, delta-neutral strategies, or
  wants to simulate trades across Twilight, Binance, and Bybit.
---

# Twilight Strategy API

Query live trading strategies, market data, and simulate trade impact using the
Twilight Strategy API.

## Base URL

```
https://strategy.lunarpunk.xyz
```

## Authentication

`/api/health` is always public. Other endpoints require an API key:

```
Header: x-api-key: 123hEll@he
# or query param: ?api_key=123hEll@he
```

**Note:** the public `https://strategy.lunarpunk.xyz` endpoint is fronted by
nginx, which injects the key automatically. Calls via that URL succeed with
or without the header. Sending the header anyway is harmless and lets the
same curl work against any deployment (including direct port-3000 access on
hosts where nginx isn't in front).

## Endpoints

### Health Check
```bash
curl https://strategy.lunarpunk.xyz/api/health
```

### Live Market Data
```bash
curl -H "x-api-key: 123hEll@he" https://strategy.lunarpunk.xyz/api/market
```
Returns: live prices, funding rates, spreads, pool skew.

### All Strategies (with live calculations)
```bash
curl -H "x-api-key: 123hEll@he" "https://strategy.lunarpunk.xyz/api/strategies"
```

### Filter Strategies
```bash
# By category
curl -H "x-api-key: 123hEll@he" "https://strategy.lunarpunk.xyz/api/strategies?category=Delta-Neutral"

# By risk level
curl -H "x-api-key: 123hEll@he" "https://strategy.lunarpunk.xyz/api/strategies?risk=LOW"

# Only profitable
curl -H "x-api-key: 123hEll@he" "https://strategy.lunarpunk.xyz/api/strategies?profitable=true"

# Minimum APY threshold
curl -H "x-api-key: 123hEll@he" "https://strategy.lunarpunk.xyz/api/strategies?minApy=50"

# Limit results
curl -H "x-api-key: 123hEll@he" "https://strategy.lunarpunk.xyz/api/strategies?profitable=true&limit=5"
```

### Single Strategy by ID
```bash
curl -H "x-api-key: 123hEll@he" "https://strategy.lunarpunk.xyz/api/strategies/:id"
```

### Run Custom Strategy
```bash
curl -X POST -H "x-api-key: 123hEll@he" -H "Content-Type: application/json" \
  -d '{"twilightPosition":"SHORT","twilightSize":200,"twilightLeverage":10,"binancePosition":"LONG","binanceSize":200,"binanceLeverage":10}' \
  https://strategy.lunarpunk.xyz/api/strategies/run
```

### Simulate Trade Impact on Pool
```bash
curl -X POST -H "x-api-key: 123hEll@he" -H "Content-Type: application/json" \
  -d '{"tradeSize":500,"direction":"LONG"}' \
  https://strategy.lunarpunk.xyz/api/impact
```
Returns `longImpact` and `shortImpact` for the given `tradeSize` (both
directions are computed regardless of `direction`, which is required but
ignored). Response also carries `source` (`"chain"` when live chain pool
sizes are used, `"config"` when the manually-configured poolConfig is the
fallback) and `poolUsed` showing the long/short notional that was used.

### List Categories
```bash
curl -H "x-api-key: 123hEll@he" https://strategy.lunarpunk.xyz/api/categories
```

### Pool Configuration
```bash
# Get current pool config
curl -H "x-api-key: 123hEll@he" https://strategy.lunarpunk.xyz/api/pool

# Update pool config
curl -X POST -H "x-api-key: 123hEll@he" -H "Content-Type: application/json" \
  -d '{"tvl":500,"longSize":300,"shortSize":200}' \
  https://strategy.lunarpunk.xyz/api/pool
```

## Response fields worth knowing

`/api/market` carries:

- `prices.{twilight, binanceFutures, binanceMarkPrice, bybit}`
- `fundingRates.twilight.{rate, ratePct, annualizedAPY, source,
  lastFundingTimestamp, estimatedRate, estimatedRatePct, estimatedAPY,
  nextFundingTimestamp}` — `source: "relayer"` means the rate is the
  chain-side value from `get_market_stats`; `"computed"` means the
  formula-based fallback. `estimatedRate` is the predicted next-period
  rate (canonical Twilight settlement is per-8h).
- `fundingRates.binance.{rate, ratePct, annualizedAPY, nextFundingTime}`
- `fundingRates.bybit.{rate, ratePct, annualizedAPY, nextFundingTime}`
- `spreads.{twilightVsBinance, twilightVsBybit}.{usd, pct}`
- `pool.{currentSkew, currentSkewPct, isLongHeavy, isShortHeavy}` —
  derived from the configured poolConfig.
- `chainPool.{status, statusReason, longPct, shortPct, totalLongBtc,
  totalShortBtc, openInterestBtc, poolEquityBtc, utilization,
  utilizationPct, riskParams}` — live from the chain via the relayer.
  `null` if the relayer is unreachable.
- `connections.*` — connection state + last-update timestamps for each
  feed (spot, futures, markPrice, bybit, relayer).

`/api/impact` carries `source`, `poolUsed`, `currentSkew`, `longImpact`,
`shortImpact` (each impact has `newSkew`, `newFundingRate`,
`annualizedAPY`, `youPay`, `youEarn`, `helpsBalance`).

## Strategy Categories

- **Directional**: Pure long/short on a single venue
- **Delta-Neutral**: Hedged positions across venues (long one, short other)
- **Funding Arbitrage**: Exploit funding rate differentials
- **Inverse Perp Arb**: Twilight vs Bybit inverse perpetuals (both BTC-margined)
- **Funding Harvest**: Earn funding when pool skew favors your side
- **Dual Arbitrage**: Both sides pay you when conditions align
- **Conservative**: Low leverage for safety
- **Stablecoin**: Create stable USD value by shorting with spot BTC

## Key Insight

Twilight charges **0% funding** and **0% trading fees**. Every strategy exploits
this against Binance (0.04% taker, 8h funding) and Bybit (0.055% taker).

## Infrastructure

- Runtime: Node.js 20 + Express
- Process Manager: pm2
- Data: Live WebSocket feeds from Binance (futures + mark price) and Bybit inverse
- 38 strategies across 9 categories generated in real-time
