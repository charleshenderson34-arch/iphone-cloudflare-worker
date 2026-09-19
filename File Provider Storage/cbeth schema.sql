-- cbETH tracking tables. Same idempotency pattern as doge_utxos: primary
-- keys are real on-chain identifiers, so re-running never fabricates rows.

CREATE TABLE IF NOT EXISTS cbeth_balances (
  address           TEXT PRIMARY KEY,
  balance_raw       TEXT NOT NULL,        -- uint256 as decimal string (too big for INTEGER)
  balance_cbeth     TEXT NOT NULL,        -- human-readable decimal string
  exchange_rate     TEXT NOT NULL,        -- cbETH:ETH rate at time of read
  underlying_eth    TEXT NOT NULL,
  last_synced_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sentio_synced     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cbeth_balances_pending_sync
  ON cbeth_balances(sentio_synced) WHERE sentio_synced = 0;

-- Mint/Burn events, keyed on (tx_hash, log_index) which is unique per log
-- on-chain — the same "real identity as primary key" idempotency trick as
-- (txid, vout) in doge_utxos.
CREATE TABLE IF NOT EXISTS cbeth_events (
  tx_hash           TEXT NOT NULL,
  log_index         INTEGER NOT NULL,
  event_type        TEXT NOT NULL,        -- 'Mint' or 'Burn'
  counterparty      TEXT NOT NULL,        -- minter/to for Mint, burner for Burn
  amount_raw        TEXT NOT NULL,
  amount_cbeth      TEXT NOT NULL,
  block_number      INTEGER NOT NULL,
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sentio_synced     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_cbeth_events_pending_sync
  ON cbeth_events(sentio_synced) WHERE sentio_synced = 0;

-- Reuse the same watched_addresses table from the Doge indexer if this lives
-- in the same Worker/DB; otherwise create it here too.
CREATE TABLE IF NOT EXISTS watched_eth_addresses (
  address     TEXT PRIMARY KEY,
  label       TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tiny key/value table for cursor state (e.g. last scanned block), so cold
-- starts don't rescan from genesis.
CREATE TABLE IF NOT EXISTS sync_state (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL
);
