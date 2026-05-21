# Setup External Dependencies

Help the developer set up and manage the two external dependencies that require manual steps after cloning or forking this repo: the **twilight-bot git submodule** and the **twilight-relayer-cli binary**.

## Your task

Walk through the following checks and guide the developer through any that are not yet complete. Run commands to verify state before giving instructions.

---

## 1. twilight-bot submodule

The bot lives at `external/twilight-bot` and is a git submodule pointing to `https://github.com/runnerelectrode/twilight-bot.git`.

**Check state:**
```bash
git submodule status external/twilight-bot
```

Interpret output:
- Starts with `-` → not initialized. Run: `git submodule update --init --recursive external/twilight-bot`
- Starts with `+` → checked out at a different commit than `.gitmodules` records. Run: `git submodule update --recursive external/twilight-bot`
- Starts with ` ` (space) → up to date, no action needed.

**After init, install and build the bot:**
```bash
cd external/twilight-bot && npm install && npm run build
```

The bot is a TypeScript project; `npm run build` compiles to `dist/`. Confirm `dist/index.js` exists after the build.

**Key env vars for the bot** (set in repo-root `.env`):
```
TWILIGHT_BOT_BASE_URL=http://127.0.0.1:8787
TWILIGHT_BOT_API_TOKEN=            # set a strong random token
TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN=YES   # enables one-click start from the Agentic tab
TWILIGHT_BOT_TIMEOUT_MS=15000
```

To start the bot manually: `cd external/twilight-bot && npm start`  
The dashboard Agentic tab can also spin it up automatically when `TWILIGHT_BOT_ALLOW_DASHBOARD_SPAWN=YES`.

---

## 2. twilight-relayer-cli binary

The dashboard's wallet, faucet, and (optional) live-order features all call a `relayer-cli` binary compiled from [nyks-wallet](https://github.com/twilight-project/nyks-wallet). This binary is **never committed** to the repo.

**Check state:**
```bash
ls dashboard/tools/relayer-cli 2>/dev/null && echo "found" || echo "missing"
```

If missing, pick one path:

### Path A — auto-install via `npm install` (recommended for local dev)

Set the appropriate env var in `.env` before running `npm install` inside `dashboard/`:

| Goal | Env var to set |
|------|---------------|
| Download a pre-built Linux binary | `RELAYER_CLI_URL=https://<your-host>/relayer-cli-linux-x86_64` |
| Build from source (needs Rust + protoc + libpq + OpenSSL) | `RELAYER_CLI_BUILD=1` |
| Skip entirely (you'll point to your own binary) | `SKIP_RELAYER_CLI_INSTALL=1` |

Then: `cd dashboard && npm install`

The postinstall script writes the binary to `dashboard/tools/relayer-cli`.

### Path B — Dockerfile / hosted deployment (Render, Fly, etc.)

The root `Dockerfile` builds `relayer-cli` from source in a Rust stage and copies it to `/app/tools/relayer-cli`. No manual steps needed — just build the image. See `docs/deploy-relayer.md` for full details.

### Path C — point to an existing binary

If you already have a compiled `relayer-cli` binary (e.g. from building nyks-wallet yourself):

```
TWILIGHT_RELAYER_CLI=/absolute/path/to/relayer-cli
```

Set this in `.env`. The dashboard resolves this path first before looking in `dashboard/tools/`.

**Enable wallet/order features** (explicit opt-in required, localhost only):
```
RELAYER_ALLOW_DASHBOARD_ZK=YES      # ZkOS fund / transfer
RELAYER_ALLOW_DASHBOARD_ORDERS=YES  # order open / close / cancel
```

---

## 3. Verify the .env file exists

```bash
ls .env 2>/dev/null && echo "found" || echo "missing — copy configs/env.example to .env"
```

If missing: `cp configs/env.example .env` then fill in `STRATEGY_API_KEY` and any CEX keys.

---

## 4. Quick-start checklist

After guiding the developer, confirm all of the following are true:

- [ ] `git submodule status external/twilight-bot` shows no `-` prefix
- [ ] `external/twilight-bot/dist/index.js` exists
- [ ] `dashboard/tools/relayer-cli` exists OR `TWILIGHT_RELAYER_CLI` points to a valid binary OR deployment uses the Dockerfile
- [ ] `.env` exists at repo root with at minimum `STRATEGY_API_KEY` set
- [ ] Dashboard starts cleanly: `cd dashboard && npm start` (should bind on port 3847)

If any item is incomplete, provide the exact commands to fix it.
