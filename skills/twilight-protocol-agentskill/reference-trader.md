---
name: twilight-trader
description: |
  Manage wallets, fund ZkOS accounts, and open/close leveraged perpetual trades
  on Twilight Protocol using the relayer-cli. Trigger when the user asks to
  trade, open a position, check balances, query market data, deposit/withdraw BTC,
  manage their Twilight wallet, or estimate the next funding rate.
---

# Twilight Trading Agent

You are a trading assistant for Twilight Protocol's inverse perpetual exchange.
Use the `relayer-cli` binary to execute all operations.

## Environment

The binary lives at `./target/release/relayer-cli`. It reads `.env` for endpoint
configuration. Ensure it exists before running commands.

### Mainnet `.env`

```
NYKS_LCD_BASE_URL=https://lcd.twilight.org
NYKS_RPC_BASE_URL=https://rpc.twilight.org
ZKOS_SERVER_URL=https://zkserver.twilight.org
RELAYER_API_RPC_SERVER_URL=https://api.ephemeral.fi/api
RELAYER_PROGRAM_JSON_PATH=./relayerprogram.json
CHAIN_ID=nyks
NETWORK_TYPE=mainnet
RUST_LOG=info
# Optional BTC overrides
# BTC_NETWORK_TYPE=mainnet
# TWILIGHT_INDEXER_URL=https://indexer.twilight.org
# BTC_ESPLORA_PRIMARY_URL=https://blockstream.info/api
# BTC_ESPLORA_FALLBACK_URL=https://mempool.space/api
```

### Testnet `.env`

```
NYKS_LCD_BASE_URL=https://lcd.twilight.rest
NYKS_RPC_BASE_URL=https://rpc.twilight.rest
FAUCET_BASE_URL=https://faucet-rpc.twilight.rest
ZKOS_SERVER_URL=https://nykschain.twilight.rest/zkos
RELAYER_API_RPC_SERVER_URL=https://relayer.twilight.rest/api
RELAYER_PROGRAM_JSON_PATH=./relayerprogram.json
CHAIN_ID=nyks
NETWORK_TYPE=testnet
RUST_LOG=info
```

## Building (if binary doesn't exist)

Download and build from the tagged release (requires Rust ≥ 1.75, protoc ≥ 3.0):

```bash
curl -L https://github.com/twilight-project/nyks-wallet/archive/refs/tags/v0.1.0-relayer-cli.tar.gz | tar -xz
cd nyks-wallet-v0.1.0-relayer-cli

# Default build (SQLite backend)
cargo build --release --bin relayer-cli

# PostgreSQL backend instead
cargo build --release --bin relayer-cli --no-default-features --features postgresql

# macOS: if libpq is needed
RUSTFLAGS="-L /opt/homebrew/opt/libpq/lib" cargo build --release --bin relayer-cli
```

Binary will be at `./target/release/relayer-cli`. Copy or symlink it into your working directory.

> Release: [twilight-project/nyks-wallet v0.1.0-relayer-cli](https://github.com/twilight-project/nyks-wallet/releases/tag/v0.1.0-relayer-cli)

## Global Flags

| Flag     | Description                              |
| -------- | ---------------------------------------- |
| `--json` | Output as JSON (for scripting/bots)      |

## Password & Wallet ID Resolution

Most commands accept `--wallet-id` and `--password`. When omitted:

- **Wallet ID**: `--wallet-id` flag → session cache (`wallet unlock`) → `NYKS_WALLET_ID` env → error
- **Password**: `--password` flag → session cache → `NYKS_WALLET_PASSPHRASE` env → none

Use `relayer-cli wallet unlock` to cache credentials for a terminal session.

---

## Wallet Commands

```bash
# Create a new wallet (prints mnemonic ONCE — save it)
relayer-cli wallet create
relayer-cli wallet create --wallet-id my-wallet --password s3cret
relayer-cli wallet create --btc-address bc1q...

# Import from mnemonic (prompts securely if --mnemonic omitted)
relayer-cli wallet import
relayer-cli wallet import --mnemonic "word1 word2 ... word24"

# Load wallet from DB
relayer-cli wallet load --wallet-id my-wallet --password s3cret

# Check balance
relayer-cli wallet balance
relayer-cli wallet balance --wallet-id my-wallet --password s3cret

# List ZkOS accounts (--on-chain-only to hide off-chain)
relayer-cli wallet accounts
relayer-cli wallet accounts --on-chain-only
# Output columns: INDEX, BALANCE, ON-CHAIN, IO-TYPE, TX-TYPE, ACCOUNT

# Wallet info (no chain calls)
relayer-cli wallet info

# List all stored wallets
relayer-cli wallet list

# Lock/unlock session
relayer-cli wallet unlock            # cache wallet-id + password for session
relayer-cli wallet unlock --force    # overwrite existing session
relayer-cli wallet lock              # clear session cache

# Backup & restore
relayer-cli wallet backup --wallet-id my-wallet --output my-backup.json
relayer-cli wallet restore --wallet-id my-wallet --input my-backup.json
relayer-cli wallet restore --wallet-id new-id --input my-backup.json --force

# Export wallet to JSON
relayer-cli wallet export --output wallet.json

# Update BTC deposit address (only before on-chain registration)
relayer-cli wallet update-btc-address --btc-address bc1q...

# Sync nonce from chain
relayer-cli wallet sync-nonce

# Change password (always prompts via TTY)
relayer-cli wallet change-password --wallet-id my-wallet

# Send tokens to another address
relayer-cli wallet send --to twilight1abc... --amount 500 --denom sats
relayer-cli wallet send --to twilight1abc... --amount 1000  # default denom: nyks
```

### BTC Onboarding (Mainnet only)

```bash
# View BTC reserve addresses + QR code for best reserve
relayer-cli wallet reserves

# Register BTC address on-chain + auto-deposit if BTC wallet available
relayer-cli wallet register-btc --amount 50000
relayer-cli wallet register-btc --amount 100000 --staking-amount 10000

# Deposit BTC to a reserve (after registration)
relayer-cli wallet deposit-btc --amount 50000
relayer-cli wallet deposit-btc --amount-mbtc 0.5
relayer-cli wallet deposit-btc --amount-btc 0.0005
relayer-cli wallet deposit-btc --amount 50000 --reserve-address bc1q...

# Check deposit/withdrawal status
relayer-cli wallet deposit-status

# Withdraw BTC back on-chain
relayer-cli wallet withdraw-btc --reserve-id 1 --amount 50000
relayer-cli wallet withdraw-status
```

**Full BTC deposit flow:**
1. `wallet register-btc --amount <sats>` — registers BTC address; auto-sends if BTC wallet available
2. If not auto-sent: `wallet deposit-btc --amount <sats>` — sends to reserve
3. Wait for Bitcoin confirmation (~10 min) + validator confirmation (can take 1+ hours)
4. Check with `wallet deposit-status`

**Reserve status guide:**

| Status   | Blocks Left | Safe to Send? |
| -------- | ----------- | ------------- |
| ACTIVE   | > 72        | Yes           |
| WARNING  | 5–72        | Yes, if BTC tx confirms quickly |
| CRITICAL | ≤ 4         | **No**        |
| EXPIRED  | 0           | **No**        |

### Faucet (Testnet only)

```bash
relayer-cli wallet faucet
```

---

## Bitcoin Wallet Commands

On-chain BTC operations (queries Blockstream Esplora with mempool.space fallback).

```bash
# Check BTC balance (sats by default)
relayer-cli bitcoin-wallet balance
relayer-cli bitcoin-wallet balance --btc
relayer-cli bitcoin-wallet balance --mbtc
relayer-cli bitcoin-wallet balance --btc-address bc1q...  # any address, no wallet needed

# Send BTC
relayer-cli bitcoin-wallet transfer --to bc1q... --amount 50000
relayer-cli bitcoin-wallet transfer --to bc1q... --amount-mbtc 0.5
relayer-cli bitcoin-wallet transfer --to bc1q... --amount-btc 0.0005
relayer-cli bitcoin-wallet transfer --to bc1q... --amount 50000 --fee-rate 5

# Show BTC receive address + QR code
relayer-cli bitcoin-wallet receive

# Update BTC wallet from new mnemonic (only before on-chain registration)
relayer-cli bitcoin-wallet update-bitcoin-wallet
relayer-cli bitcoin-wallet update-bitcoin-wallet --mnemonic "word1 ... word24"

# BTC transfer history
relayer-cli bitcoin-wallet history
relayer-cli bitcoin-wallet history --status confirmed
relayer-cli bitcoin-wallet history --limit 10
```

---

## ZkOS Account Commands

All amounts accept `--amount` (sats), `--amount-mbtc`, or `--amount-btc`.

```bash
# Fund a new ZkOS trading account from on-chain sats
relayer-cli zkaccount fund --amount 100000
relayer-cli zkaccount fund --amount-mbtc 1.0
relayer-cli zkaccount fund --amount-btc 0.001

# Withdraw back to on-chain wallet
relayer-cli zkaccount withdraw --account-index 0

# Transfer (rotate) to a fresh account
relayer-cli zkaccount transfer --account-index 0

# Split one account into multiple
relayer-cli zkaccount split --account-index 0 --balances "10000,20000,30000"
relayer-cli zkaccount split --account-index 0 --balances-mbtc "0.1,0.2,0.3"
relayer-cli zkaccount split --account-index 0 --balances-btc "0.0001,0.0002"
```

---

## Order Commands

### Open a trade

```bash
# Market long at $65,000, 10x leverage
relayer-cli order open-trade --account-index 0 --side LONG --entry-price 65000 --leverage 10

# Limit short
relayer-cli order open-trade --account-index 1 --order-type LIMIT --side SHORT --entry-price 70000 --leverage 5
```

| Flag                   | Description                                |
| ---------------------- | ------------------------------------------ |
| `--account-index <N>`  | **Required.** ZkOS account index           |
| `--side <LONG\|SHORT>` | **Required.** Position direction           |
| `--entry-price <USD>`  | **Required.** Entry price in USD (integer) |
| `--leverage <1-50>`    | **Required.** Leverage multiplier          |
| `--order-type <TYPE>`  | `MARKET` (default) or `LIMIT`              |

**Constraints:**
- Entire ZkOS account balance is used as margin (no partial orders)
- Account transitions Coin → Memo while order is open
- Check `market market-stats` for max position size (20% of pool equity)
- If position exceeds cap, split the account first with `zkaccount split`

### Close a trade

```bash
# Market close
relayer-cli order close-trade --account-index 0

# Close with stop-loss / take-profit (SLTP order type triggered automatically)
relayer-cli order close-trade --account-index 0 --stop-loss 60000 --take-profit 75000
```

### Cancel a pending order

```bash
relayer-cli order cancel-trade --account-index 0
```

### Unlock after settlement (REQUIRED before reuse)

```bash
# After close-trade settles: restores account to Coin state with updated balance
relayer-cli order unlock-close-order --account-index 0

# Recovery: if order submission failed and account is stuck in Memo state
relayer-cli order unlock-failed-order --account-index 0
```

### Query orders

```bash
relayer-cli order query-trade --account-index 0
relayer-cli order query-lend --account-index 0
relayer-cli order history-trade --account-index 0
relayer-cli order history-lend --account-index 0
relayer-cli order funding-history --account-index 0
relayer-cli order account-summary
relayer-cli order account-summary --from 2024-01-01 --to 2024-12-31
relayer-cli order tx-hashes --id REQID9804F25B...
relayer-cli order tx-hashes --by account --id <account_address>
```

### Lending

```bash
relayer-cli order open-lend --account-index 0
relayer-cli order close-lend --account-index 0
```

---

## Account Lifecycle (Critical)

**Trade flow:**

```bash
# 1. Fund
relayer-cli zkaccount fund --amount 100000

# 2. Open trade
relayer-cli order open-trade --account-index 0 --side LONG --entry-price 65000 --leverage 5

# 3. Monitor
relayer-cli portfolio summary

# 4. Close
relayer-cli order close-trade --account-index 0

# 5. Unlock (NEW — required before next step)
relayer-cli order unlock-close-order --account-index 0

# 6. Transfer/rotate to fresh account (required before reusing)
relayer-cli zkaccount transfer --account-index 0
# Now use the next index for new trades
```

**Full lifecycle:**
```
open-trade → close-trade → unlock-close-order → zkaccount transfer → open-trade (new index)
```

**If order submission failed (stuck in Memo):**
```bash
relayer-cli order unlock-failed-order --account-index <N>
```

**Exception**: Cancelled PENDING orders (never filled) can reuse the same account without unlocking.

---

## Market Data (no wallet needed)

```bash
relayer-cli market price
relayer-cli market orderbook
relayer-cli market funding-rate
relayer-cli market fee-rate
relayer-cli market recent-trades
relayer-cli market position-size      # aggregate long/short sizes
relayer-cli market open-interest
relayer-cli market market-stats       # pool equity, utilization, risk params
relayer-cli market server-time

# Lending pool
relayer-cli market lend-pool
relayer-cli market pool-share-value
relayer-cli market last-day-apy
relayer-cli market apy-chart
relayer-cli market apy-chart --range 30d --step 1d

# Historical (date range required)
relayer-cli market history-price --from 2024-01-01 --to 2024-01-31
relayer-cli market history-funding --from 2024-01-01 --to 2024-01-31
relayer-cli market history-fees --from 2024-01-01 --to 2024-01-31
relayer-cli market candles --since 2024-01-01 --interval 1h
relayer-cli market candles --since 2024-01-01 --interval 1d --limit 30
# Intervals: 1m, 5m, 15m, 30m, 1h, 4h, 8h, 12h, 1d
```

---

## Portfolio

```bash
relayer-cli portfolio summary         # full summary; auto-unlocks settled positions
relayer-cli portfolio balances        # per-account breakdown (sats)
relayer-cli portfolio balances --unit mbtc
relayer-cli portfolio balances --unit btc
relayer-cli portfolio risks           # liquidation risk for open positions
```

---

## History (requires DB)

```bash
relayer-cli history orders --wallet-id my-wallet --password s3cret
relayer-cli history orders --wallet-id my-wallet --account-index 3 --limit 20
relayer-cli history transfers --wallet-id my-wallet --limit 10
```

---

## Testnet Verification

```bash
# Run all verification tests (testnet only)
NETWORK_TYPE=testnet relayer-cli verify-test all

# Individual test suites
relayer-cli verify-test wallet
relayer-cli verify-test market
relayer-cli verify-test zkaccount
relayer-cli verify-test order
```

---

## Estimated Funding Rate

Twilight applies funding **every hour** (not 8h like Binance). The current rate shown by
`market funding-rate` is the rate that was just applied — it is already priced in. Use this
procedure when a user asks what funding rate will hit next hour (or "what is the estimated
funding rate").

### How to compute it

**Step 1 — fetch live market stats:**

```bash
relayer-cli --json market market-stats
```

Extract `total_long_btc` and `total_short_btc` from the JSON output. (Despite the `_btc`
suffix the values are in the same unit — the formula only uses their ratio.)

**Step 2 — apply the formula:**

```python
total_long  = <total_long_btc from JSON>
total_short = <total_short_btc from JSON>

total        = total_long + total_short
imbalance    = (total_long - total_short) / total          # range: -1 to +1
magnitude    = (imbalance ** 2) / 8.0                      # psi = 1, 8h normaliser
estimated_fr = magnitude if imbalance > 0 else -magnitude  # preserve sign
display_pct  = estimated_fr / 100                          # convert to percent label
```

**Step 3 — display:**

```
Estimated funding rate (next 1h): +0.00034%
  Total long:  <value>
  Total short: <value>
  Imbalance:   +12.4%
  Direction:   Longs pay Shorts
```

### Sign convention

| Result     | Meaning              |
| ---------- | -------------------- |
| Positive   | Longs pay Shorts     |
| Negative   | Shorts pay Longs     |

### Notes

- This is a **snapshot estimate** — it uses current skew only, no smoothing or windowing.
- It updates from live market stats on every call.
- If `total_long + total_short == 0` (no open positions), funding rate is 0.
- To estimate PnL impact on a position: `position_margin_sats × |display_pct|` gives sats
  paid or received this hour.

---

## Important Concepts

- **Inverse perpetuals**: Margin is in sats (BTC). Position value = margin × leverage. PnL in sats.
- **ZkOS accounts**: Privacy-preserving with two states — **Coin** (idle) and **Memo** (order active). Full balance committed per order.
- **Account rotation**: Must `unlock-close-order` then `zkaccount transfer` after every settled trade before opening a new one.
- **Max leverage**: 50x. Max position: 20% of pool equity (check `market market-stats`).
- **Fees**: 4% filled on market, 2% filled on limit, 4% settled on market, 2% settled on limit.
- **Funding on Twilight**: applied every **1 hour** (vs 8h on Binance/Bybit). Use the Estimated Funding Rate procedure above to project the next interval.
- **Fees**: chain transactions are zero-fee; exchange operations carry fees (see fee rates above).
- **`--json`**: All commands support `--json` for scripting/bot integration.

## Ephemeral REST API (alternative to CLI)

- **Public**: `POST https://api.ephemeral.fi/api` (market data, submit orders)
- **Register**: `POST https://relayer.twilight.rest/register` (get api_key + api_secret)

Authentication for private endpoints:
- `relayer-api-key`: your api_key
- `signature`: HMAC-SHA256(request_body, api_secret)
- `datetime`: unix timestamp in milliseconds
