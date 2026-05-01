# Twilight Strategy API (reference)

Synced from [agentskill `.claude/skills/twilight-strategies.md`](https://github.com/twilight-project/agentskill/blob/main/.claude/skills/twilight-strategies.md).

## Base URL

```
https://strategy.lunarpunk.xyz
```

## Authentication

`/api/health` is public. Other endpoints require an API key:

```
Header: x-api-key: 123hEll@he
# or query param: ?api_key=123hEll@he
```

**Note:** the public endpoint is fronted by nginx and injects the key automatically.
Calls through `https://strategy.lunarpunk.xyz` typically work with or without the
header. Keeping the header in examples is harmless and portable.

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

Returns `longImpact` and `shortImpact` for the given `tradeSize`.

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

Twilight charges **0% funding** and **0% trading fees**. Every strategy exploits this against Binance (0.04% taker, 8h funding) and Bybit (0.055% taker).
