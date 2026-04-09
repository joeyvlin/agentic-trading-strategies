# relayer-cli on the server

The dashboard spawns `relayer-cli` for wallet, faucet, and (optional) live orders. On a remote host you **cannot** use a path on your laptop.

## 1. Dockerfile (recommended for Render, Fly, etc.)

The repo includes a **root `Dockerfile`** that builds `relayer-cli` from [nyks-wallet](https://github.com/twilight-project/nyks-wallet) in a Rust stage, then copies the binary to `/app/tools/relayer-cli` and sets `TWILIGHT_RELAYER_CLI` for the Node process. The image also copies `agents/`, `configs/`, and `dashboard/`, runs `npm ci` in both `dashboard` and `agents/twilight-strategy-monitor`, and starts `node server.mjs` from `dashboard/`.

On Render: create a **Web Service** from the **Docker** runtime and point it at this Dockerfile.

## 2. `npm install` hook (dashboard)

`dashboard/package.json` runs `scripts/install-relayer-cli.mjs` on **postinstall**. It can:

| Env | Behavior |
|-----|----------|
| `SKIP_RELAYER_CLI_INSTALL=1` | Skip (you already have a binary). |
| `RELAYER_CLI_URL` | HTTPS URL to a **Linux** `relayer-cli` binary → saved as `tools/relayer-cli`. |
| `RELAYER_CLI_BUILD=1` | `git clone` nyks-wallet + `cargo build --release --bin relayer-cli` (needs Rust, git, and system deps: OpenSSL, protobuf, libpq, etc.). |

The built binary is written to **`tools/relayer-cli`** (gitignored). The dashboard resolves it automatically after `TWILIGHT_RELAYER_CLI` and the sibling `../nyks-wallet` path.

## 3. Manual `TWILIGHT_RELAYER_CLI`

Still supported: set to the absolute path of a binary you installed yourself.

## Build notes

- Building nyks-wallet from source may require **protoc**, **libpq**, **OpenSSL** dev packages (see nyks-wallet README). The Dockerfile installs those on Debian.
- Builds can take **5–15+ minutes**; ensure your CI timeout is sufficient.
