# Security and secrets

- Never commit **Twilight** or **exchange** API keys, **wallet mnemonics**, or **HMAC secrets**.
- Copy `configs/env.example` to `.env` locally; add `.env` only to deployment secret stores (e.g. GitHub Actions secrets), not to the repo.
- Rotate credentials if they are ever exposed or if team membership changes.
- Run production execution only on **hardened** hosts; restrict SSH and use least-privilege API keys (trade-only where possible).

Public documentation sometimes includes **example** Strategy API keys. Treat those as illustrative; use keys issued for your own use in production.
