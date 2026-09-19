-- Real UTXO ledger. Primary key is the actual on-chain (txid, vout) pair —
-- this is what gives us idempotency: re-running the poller never creates
-- duplicate or fabricated rows, it just no-ops on conflict.

CREATE TABLE IF NOT EXISTS doge_utxos (
  txid            TEXT NOT NULL,
  vout            INTEGER NOT NULL,
  address         TEXT NOT NULL,
  value_sats      INTEGER NOT NULL,      -- DOGE amount in the smallest unit, as returned by Alchemy
  height          INTEGER,               -- block height; NULL if still in mempool
  confirmations   INTEGER NOT NULL DEFAULT 0,
  is_spent        INTEGER NOT NULL DEFAULT 0,
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sentio_synced   INTEGER NOT NULL DEFAULT 0,   -- 0 = not yet pushed to Sentio, 1 = pushed
  PRIMARY KEY (txid, vout)
);

CREATE INDEX IF NOT EXISTS idx_doge_utxos_address ON doge_utxos(address);
CREATE INDEX IF NOT EXISTS idx_doge_utxos_pending_sync ON doge_utxos(sentio_synced) WHERE sentio_synced = 0;

-- Tracks which addresses/descriptors this Worker is watching, so the cron
-- job knows what to poll without you hardcoding a list in the source.
CREATE TABLE IF NOT EXISTS watched_addresses (
  address     TEXT PRIMARY KEY,
  label       TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
