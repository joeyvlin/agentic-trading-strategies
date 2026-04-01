# Agents

Each subdirectory is one **agent**: a named automation with its own configuration, entrypoint, and operational notes.

## Conventions (recommended)

- `README.md` — Purpose, inputs, outputs, and how to run (dry-run vs. live).
- Risk parameters documented next to code or in `configs/` with non-secret defaults.

## Current

| Agent | Status | Description |
|-------|--------|-------------|
| [twilight-strategy-monitor](twilight-strategy-monitor/) | Scaffold | Monitor Twilight Strategy API for profitable strategies; future: coordinated execution on Twilight + CEX |
