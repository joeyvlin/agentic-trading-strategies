# BTC onboarding (mainnet)

Synced from:
- [nyks-wallet/docs/btc-onboarding.md](https://github.com/twilight-project/nyks-wallet/blob/main/docs/btc-onboarding.md)

Use this when the goal is **mainnet** SATS funding without faucet.

## Flow overview

1. Register BTC address on Twilight
2. Deposit BTC to reserve
3. Wait confirmations and validator credit
4. Fund ZkOS account from on-chain sats
5. Trade
6. Withdraw BTC back out when needed

## Prerequisites

- `NETWORK_TYPE=mainnet`
- wallet exists and is unlockable
- BTC address configured in wallet (`wallet info` / `wallet update-btc-address`)
- sufficient BTC balance on that address

## Main commands

### 1) Register BTC address (one-time per address)

```bash
relayer-cli wallet register-btc --amount 50000 --wallet-id <ID> --password <PASS>
```

### 2) Deposit BTC

```bash
relayer-cli wallet deposit-btc --amount 50000 --wallet-id <ID> --password <PASS>
# or with explicit reserve
relayer-cli wallet deposit-btc --amount 50000 --reserve-address bc1q... --wallet-id <ID> --password <PASS>
```

### 3) Check deposit confirmation

```bash
relayer-cli wallet deposit-status --wallet-id <ID> --password <PASS>
relayer-cli wallet balance --wallet-id <ID> --password <PASS>
```

### 4) Move on-chain sats into ZkOS

```bash
relayer-cli zkaccount fund --amount 50000 --wallet-id <ID> --password <PASS>
relayer-cli wallet accounts --wallet-id <ID> --password <PASS>
```

## Withdraw path (later)

```bash
# if funds are in ZkOS, withdraw to on-chain first
relayer-cli zkaccount withdraw --account-index <INDEX> --wallet-id <ID> --password <PASS>

# then request BTC withdrawal
relayer-cli wallet withdraw-btc --reserve-id <ID> --amount 50000 --wallet-id <ID> --password <PASS>
relayer-cli wallet withdraw-status --wallet-id <ID> --password <PASS>
```

## Common pitfalls

- Using faucet on mainnet: not applicable.
- Sending BTC from a different address than the registered one: not credited as expected.
- Using expired reserve address: wait for active reserve.
- Expecting immediate SATS credit: validator/indexing confirmation can lag.

## Related upstream docs

- [btc-onboarding.md](https://github.com/twilight-project/nyks-wallet/blob/main/docs/btc-onboarding.md)
- [relayer-cli.md](https://github.com/twilight-project/nyks-wallet/blob/main/docs/relayer-cli.md)
