/**
 * cbETH tracker: Ethereum RPC -> Cloudflare D1 -> Sentio
 *
 * Mirrors the Doge UTXO indexer's shape:
 *  1. For each watched address, read live cbETH balance + exchange rate.
 *  2. Upsert into D1 (idempotent — one row per address).
 *  3. Fetch new Mint/Burn events since the last synced block, insert them
 *     keyed on (tx_hash, log_index) so re-runs never duplicate.
 *  4. Push anything not yet synced to Sentio, then mark it synced.
 *
 * Required secrets:
 *  - ETH_RPC_URL       (Alchemy/Infura/etc. Ethereum mainnet endpoint)
 *  - SENTIO_API_KEY
 * Required vars:
 *  - SENTIO_INGEST_URL
 */

import { getBalance, getMintBurnEvents } from "./cbeth.js";

async function syncBalances(db, rpcUrl) {
  const { results: addresses } = await db
    .prepare(`SELECT address FROM watched_eth_addresses`)
    .all();

  for (const { address } of addresses) {
    const info = await getBalance(rpcUrl, address);

    await db
      .prepare(
        `INSERT INTO cbeth_balances (address, balance_raw, balance_cbeth, exchange_rate, underlying_eth, last_synced_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(address) DO UPDATE SET
           balance_raw    = excluded.balance_raw,
           balance_cbeth  = excluded.balance_cbeth,
           exchange_rate  = excluded.exchange_rate,
           underlying_eth = excluded.underlying_eth,
           last_synced_at = datetime('now'),
           sentio_synced  = 0`
      )
      .bind(address, info.balanceRaw, info.balanceCbEth, info.exchangeRate, info.underlyingEth)
      .run();
  }

  return addresses.length;
}

async function syncEvents(db, rpcUrl, env) {
  // Track the last block we scanned in a tiny KV-style row in the same DB,
  // so cold starts don't rescan from genesis. Simplest approach: a
  // single-row table. Falls back to "last 2000 blocks" on first run.
  const state = await db
    .prepare(`SELECT value FROM sync_state WHERE key = 'cbeth_last_block'`)
    .first()
    .catch(() => null);

  const latestHex = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  })
    .then((r) => r.json())
    .then((j) => j.result);

  const latestBlock = parseInt(latestHex, 16);
  const fromBlock = state ? parseInt(state.value, 10) + 1 : latestBlock - 2000;

  if (fromBlock > latestBlock) return 0;

  const events = await getMintBurnEvents(rpcUrl, fromBlock, latestBlock);

  for (const ev of events) {
    const counterparty = ev.type === "Mint" ? ev.to : ev.burner;
    await db
      .prepare(
        `INSERT INTO cbeth_events (tx_hash, log_index, event_type, counterparty, amount_raw, amount_cbeth, block_number)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tx_hash, log_index) DO NOTHING`
      )
      .bind(ev.txHash, ev.logIndex, ev.type, counterparty, ev.amount, ev.amountFormatted, ev.blockNumber)
      .run();
  }

  await db
    .prepare(
      `INSERT INTO sync_state (key, value) VALUES ('cbeth_last_block', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(String(latestBlock))
    .run();

  return events.length;
}

async function pushPendingToSentio(db, env) {
  let pushed = 0;

  const { results: balances } = await db
    .prepare(`SELECT * FROM cbeth_balances WHERE sentio_synced = 0 LIMIT 200`)
    .all();

  for (const row of balances) {
    const ok = await sendToSentio(env, {
      distinctId: row.address,
      eventName: "cbeth_balance_observed",
      attributes: {
        address: row.address,
        balanceCbEth: row.balance_cbeth,
        exchangeRate: row.exchange_rate,
        underlyingEth: row.underlying_eth,
      },
    });
    if (ok) {
      await db.prepare(`UPDATE cbeth_balances SET sentio_synced = 1 WHERE address = ?`).bind(row.address).run();
      pushed++;
    }
  }

  const { results: events } = await db
    .prepare(`SELECT * FROM cbeth_events WHERE sentio_synced = 0 LIMIT 200`)
    .all();

  for (const row of events) {
    const ok = await sendToSentio(env, {
      distinctId: `${row.tx_hash}:${row.log_index}`,
      eventName: "cbeth_mint_burn",
      attributes: {
        type: row.event_type,
        counterparty: row.counterparty,
        amountCbEth: row.amount_cbeth,
        blockNumber: row.block_number,
      },
    });
    if (ok) {
      await db
        .prepare(`UPDATE cbeth_events SET sentio_synced = 1 WHERE tx_hash = ? AND log_index = ?`)
        .bind(row.tx_hash, row.log_index)
        .run();
      pushed++;
    }
  }

  return pushed;
}

async function sendToSentio(env, body) {
  const res = await fetch(env.SENTIO_INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": env.SENTIO_API_KEY },
    body: JSON.stringify({ ...body, timestamp: new Date().toISOString() }),
  });

  if (!res.ok) {
    console.error(`Sentio push failed: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

export async function runCbethSyncCycle(env) {
  const addressesPolled = await syncBalances(env.DB, env.ETH_RPC_URL);
  const eventsSeen = await syncEvents(env.DB, env.ETH_RPC_URL, env);
  const pushedToSentio = await pushPendingToSentio(env.DB, env);

  return { addressesPolled, eventsSeen, pushedToSentio };
}
