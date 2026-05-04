# Plan: dual-leg (Twilight + CEX) execution

## Goals

- Define **clear semantics** when both legs must be live (hedge integrity).
- Handle **latency / slow venues** without silent overlap or half-fills going unnoticed.
- Prefer **observability + safe defaults** over aggressive auto-hedging until policies are explicit.

## Current state (baseline)

- **Order:** Twilight `open-trade` (relayer) **then** CEX market (`ccxt`) — sequential `await`.
- **No** coordinated timeout across legs; **no** automatic unwind if leg two fails after leg one succeeds.
- **Monitor:** one poll cycle at a time; overlapping ticks were possible before the overlap guard (see `monitor-service.mjs`).

## Phase 1 — Contracts & guards (low risk)

- Document **invariant**: “leg two failure after leg one” = **manual / playbook** response (or optional flatten), not hidden retry.
- Add **per-leg timeouts** (relayer spawn + ccxt) and surface in `execution` summary / logs.
- **Idempotency key** per logical trade (already have `tradeId`) on any future retry path.

## Phase 2 — Concurrency options (policy-driven)

- **`execution.hedgeMode`**: `sequential` (default) | `parallel` | `cex_first` (if ever supported).
- **`parallel`:** `Promise.all` (or allSettled) with **max wait**; record partial state in transaction payload.
- **Risk gate:** refuse `parallel` unless caps / keys / preflight explicitly allow.

## Phase 3 — Partial-fill & recovery

- Detect **Twilight ok + CEX fail** (and reverse): persist `venueSteps` with terminal states.
- Optional **auto-flatten** or **alert-only** path (env-gated, `CONFIRM_*` style).
- **Backoff retries** for **transient** CEX errors only (classified error codes), not for Twilight Memo lock class errors.

## Phase 4 — Monitor / desk UX

- Show **leg timeline** on trade desk row (queued → twilight → cex → done / stuck).
- Dashboard banner when **recovery restart** ran (`MONITOR_RESTART_BACKOFF_MS`).

## Open questions

- Twilight **rollback** if CEX never fills — product decision (often impossible; flatten CEX-only hedge instead).
- **Funding / margin** checks before parallel fire to avoid one-sided exposure duration.
