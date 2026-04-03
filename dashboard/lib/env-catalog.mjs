/**
 * Environment keys aligned with Twilight skill docs (reference-trader, reference-strategies, configs/env.example).
 * Presets match mainnet vs testnet blocks in reference-trader.md.
 */

export const ENV_GROUPS = [
  {
    id: 'dashboard',
    title: 'Dashboard server',
    help: 'Controls the Node dashboard process (dashboard/server.mjs).',
  },
  {
    id: 'strategy',
    title: 'Twilight Strategy API',
    help: 'Used by the agent monitor and strategy tables. Auth: x-api-key.',
  },
  {
    id: 'nyks',
    title: 'Nyks chain & relayer API (relayer-cli)',
    help: 'Twilight LCD/RPC, ZkOS, relayer RPC — same as nyks-wallet .env.',
  },
  {
    id: 'faucet',
    title: 'Testnet faucet',
    help: 'Only for testnet NYKS / test sats requests from the dashboard.',
  },
  {
    id: 'wallet',
    title: 'Default wallet (optional)',
    help: 'Lets relayer-cli resolve --wallet-id / --password from the environment.',
  },
  {
    id: 'relayer_exec',
    title: 'Relayer binary & real Twilight orders',
    help: 'Path to relayer-cli; gates for dashboard-triggered ZkOS and orders.',
  },
  {
    id: 'cex',
    title: 'Binance / Bybit (real agent execution)',
    help: 'Used by the agent real executor (ccxt). Prefer testnet flags while learning.',
  },
  {
    id: 'agent',
    title: 'Agent monitor',
    help: 'Simulation vs real trading and safety gates.',
  },
];

/** @type {Array<{ key: string, group: string, label: string, help: string, secret?: boolean, type?: 'text'|'password'|'select', options?: string[] }>} */
export const ENV_DEFS = [
  {
    key: 'DASHBOARD_PORT',
    group: 'dashboard',
    label: 'Dashboard port',
    help: 'HTTP port for the control desk (default 3847).',
    type: 'text',
  },
  {
    key: 'DASHBOARD_HOST',
    group: 'dashboard',
    label: 'Bind host',
    help: '127.0.0.1 recommended (localhost only).',
    type: 'text',
  },
  {
    key: 'DASHBOARD_TOKEN',
    group: 'dashboard',
    label: 'Dashboard token',
    help: 'If set, browser must send the same value as x-dashboard-token. Leave empty to disable.',
    secret: true,
    type: 'password',
  },
  {
    key: 'STRATEGY_API_BASE_URL',
    group: 'strategy',
    label: 'Strategy API base URL',
    help: 'From skill: http://134.199.214.129:3000',
    type: 'text',
  },
  {
    key: 'STRATEGY_API_KEY',
    group: 'strategy',
    label: 'Strategy API key',
    help: 'Header x-api-key. Public example in skill docs (replace for production).',
    secret: true,
    type: 'password',
  },
  {
    key: 'NYKS_LCD_BASE_URL',
    group: 'nyks',
    label: 'NYKS LCD (REST)',
    help: 'Mainnet: https://lcd.twilight.org · Testnet: https://lcd.twilight.rest',
    type: 'text',
  },
  {
    key: 'NYKS_RPC_BASE_URL',
    group: 'nyks',
    label: 'NYKS Tendermint RPC',
    help: 'Mainnet: https://rpc.twilight.org · Testnet: https://rpc.twilight.rest',
    type: 'text',
  },
  {
    key: 'ZKOS_SERVER_URL',
    group: 'nyks',
    label: 'ZkOS server',
    help: 'Mainnet: https://zkserver.twilight.org · Testnet: https://nykschain.twilight.rest/zkos',
    type: 'text',
  },
  {
    key: 'RELAYER_API_RPC_SERVER_URL',
    group: 'nyks',
    label: 'Relayer public API',
    help: 'Mainnet: https://api.ephemeral.fi/api · Testnet: https://relayer.twilight.rest/api',
    type: 'text',
  },
  {
    key: 'RELAYER_PROGRAM_JSON_PATH',
    group: 'nyks',
    label: 'relayerprogram.json path',
    help: 'Relative to cwd when running relayer-cli (often ./relayerprogram.json in nyks-wallet).',
    type: 'text',
  },
  {
    key: 'CHAIN_ID',
    group: 'nyks',
    label: 'Chain ID',
    help: 'Typically nyks.',
    type: 'text',
  },
  {
    key: 'NETWORK_TYPE',
    group: 'nyks',
    label: 'Network type',
    help: 'mainnet or testnet — must match endpoints.',
    type: 'select',
    options: ['mainnet', 'testnet'],
  },
  {
    key: 'RUST_LOG',
    group: 'nyks',
    label: 'RUST_LOG',
    help: 'Log level for relayer-cli (info, debug, …).',
    type: 'text',
  },
  {
    key: 'FAUCET_BASE_URL',
    group: 'faucet',
    label: 'Faucet base URL',
    help: 'Testnet: https://faucet-rpc.twilight.rest — leave empty on mainnet.',
    type: 'text',
  },
  {
    key: 'NYKS_WALLET_ID',
    group: 'wallet',
    label: 'Default wallet ID',
    help: 'Stored wallet id in relayer-cli DB; optional if you always pick in the UI.',
    type: 'text',
  },
  {
    key: 'NYKS_WALLET_PASSPHRASE',
    group: 'wallet',
    label: 'Default wallet passphrase',
    help: 'Encrypts local wallet DB. Optional if typed in the dashboard only.',
    secret: true,
    type: 'password',
  },
  {
    key: 'TWILIGHT_RELAYER_CLI',
    group: 'relayer_exec',
    label: 'relayer-cli binary path',
    help: 'Full path to target/release/relayer-cli. Auto-filled if built next to this repo.',
    type: 'text',
  },
  {
    key: 'ALLOW_TWILIGHT_CLI_EXECUTION',
    group: 'relayer_exec',
    label: 'Allow real Twilight CLI orders',
    help: 'Set to 1 for agent real mode to run relayer open-trade.',
    type: 'text',
  },
  {
    key: 'TWILIGHT_ACCOUNT_INDEX',
    group: 'relayer_exec',
    label: 'ZkOS account index',
    help: 'Default account index for Twilight leg in real execution.',
    type: 'text',
  },
  {
    key: 'RELAYER_ALLOW_DASHBOARD_ZK',
    group: 'relayer_exec',
    label: 'Dashboard ZkOS (fund/transfer)',
    help: 'YES to allow ZkOS actions from this dashboard.',
    type: 'text',
  },
  {
    key: 'RELAYER_ALLOW_DASHBOARD_ORDERS',
    group: 'relayer_exec',
    label: 'Dashboard orders',
    help: 'YES to allow open/close/cancel from advanced panel.',
    type: 'text',
  },
  {
    key: 'BINANCE_API_KEY',
    group: 'cex',
    label: 'Binance API key',
    secret: true,
    type: 'password',
  },
  {
    key: 'BINANCE_API_SECRET',
    group: 'cex',
    label: 'Binance API secret',
    secret: true,
    type: 'password',
  },
  {
    key: 'BINANCE_USE_TESTNET',
    group: 'cex',
    label: 'Binance testnet',
    help: 'Set to 1 for sandbox.',
    type: 'text',
  },
  {
    key: 'BYBIT_API_KEY',
    group: 'cex',
    label: 'Bybit API key',
    secret: true,
    type: 'password',
  },
  {
    key: 'BYBIT_API_SECRET',
    group: 'cex',
    label: 'Bybit API secret',
    secret: true,
    type: 'password',
  },
  {
    key: 'BYBIT_USE_TESTNET',
    group: 'cex',
    label: 'Bybit testnet',
    help: 'Set to 1 for testnet.',
    type: 'text',
  },
  {
    key: 'AGENT_MODE',
    group: 'agent',
    label: 'Agent mode',
    help: 'simulation or real — also see configs/agent.monitor.yaml execution.mode.',
    type: 'select',
    options: ['simulation', 'real'],
  },
  {
    key: 'AGENT_CONFIG_PATH',
    group: 'agent',
    label: 'Agent config path',
    help: 'Optional override for agent.monitor.yaml location.',
    type: 'text',
  },
  {
    key: 'LOG_LEVEL',
    group: 'agent',
    label: 'Log level',
    help: 'Agent / dashboard logger (info, debug, …).',
    type: 'text',
  },
  {
    key: 'CONFIRM_REAL_TRADING',
    group: 'agent',
    label: 'Confirm real trading',
    help: 'Must be YES to start the monitor or run real execution against exchanges.',
    type: 'text',
  },
];

export const PRESET_MAINNET = {
  NYKS_LCD_BASE_URL: 'https://lcd.twilight.org',
  NYKS_RPC_BASE_URL: 'https://rpc.twilight.org',
  ZKOS_SERVER_URL: 'https://zkserver.twilight.org',
  RELAYER_API_RPC_SERVER_URL: 'https://api.ephemeral.fi/api',
  FAUCET_BASE_URL: '',
  CHAIN_ID: 'nyks',
  NETWORK_TYPE: 'mainnet',
  RUST_LOG: 'info',
  STRATEGY_API_BASE_URL: 'http://134.199.214.129:3000',
};

export const PRESET_TESTNET = {
  NYKS_LCD_BASE_URL: 'https://lcd.twilight.rest',
  NYKS_RPC_BASE_URL: 'https://rpc.twilight.rest',
  FAUCET_BASE_URL: 'https://faucet-rpc.twilight.rest',
  ZKOS_SERVER_URL: 'https://nykschain.twilight.rest/zkos',
  RELAYER_API_RPC_SERVER_URL: 'https://relayer.twilight.rest/api',
  CHAIN_ID: 'nyks',
  NETWORK_TYPE: 'testnet',
  RUST_LOG: 'info',
  STRATEGY_API_BASE_URL: 'http://134.199.214.129:3000',
};

/** Documented example key from Twilight Strategy API skill (public sample). */
export const STRATEGY_API_EXAMPLE_KEY = '123hEll@he';

/** Shown in the dashboard Environment section — where preset values come from. */
export const PRESET_SOURCE_BLURB =
  'Preset URL blocks are defined in this repo in `dashboard/lib/env-catalog.mjs` (`PRESET_TESTNET` / `PRESET_MAINNET`). They are aligned with the Twilight skill docs (`reference-trader.md`, `configs/env.example`) so mainnet vs testnet NYKS / ZkOS / relayer endpoints match the official tables. Applying a preset merges these keys into your `.env` and does not erase unrelated variables.';

/** Extra lines for the preset explainer (behavior not visible from key=value alone). */
export const PRESET_EXTRA_NOTES = {
  mainnet:
    'After apply, `FAUCET_BASE_URL` is removed from `.env` (mainnet does not use the testnet faucet endpoint).',
  testnet: 'Includes `FAUCET_BASE_URL` for test-sat requests via the dashboard faucet actions.',
};
