/**
 * Dogecoin UTXO indexer: Alchemy -> Cloudflare D1 -> Sentio
 *
 * Flow:
 *  1. Cron trigger fires on a schedule (see wrangler.toml).
 *  2. For each watched address, call Alchemy's Dogecoin UTXO REST endpoint
 *     to get the address's real current UTXO set.
 *  3. Upsert each UTXO into D1 keyed on (txid, vout) — real chain data only.
 *  4. Any UTXO not yet pushed to Sentio gets forwarded as a real event,
 *     then marked sentio_synced = 1.
 *
 * Required secrets (wrangler secret put ...):
 *  - ALCHEMY_API_KEY
 *  - SENTIO_API_KEY
 *
 * Required vars (wrangler.toml [vars]):
 *  - SENTIO_INGEST_URL   e.g. https://app.sentio.xyz/api/v1/event_logs/<project>/<endpoint>
 */

const ALCHEMY_HOST = "dogecoin-mainnet.g.alchemy.com";

async function fetchUtxosForAddress(address, apiKey) {
  // Alchemy's UTXO REST API (Blockbook-parity). Confirm the exact path
  // against current Alchemy docs before relying on it in production —
  // UTXO-chain endpoint paths have shifted as the product has matured.
  const url = `https://${ALCHEMY_HOST}/${apiKey}/api/v2/utxo/${address}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });

  if (!res.ok) {
    throw new Error(`Alchemy UTXO fetch failed (${res.status}) for ${address}: ${await res.text()}`);
  }

  // Expected shape: an array of { txid, vout, value, height, confirmations }
  return res.json();
}

async function upsertUtxo(db, address, utxo) {
  const { txid, vout, value, height = null, confirmations = 0 } = utxo;

  await db
    .prepare(
      `INSERT INTO doge_utxos (txid, vout, address, value_sats, height, confirmations, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(txid, vout) DO UPDATE SET
         confirmations  = excluded.confirmations,
         height         = excluded.height,
         last_synced_at = datetime('now')`
    )
    .bind(txid, vout, address, Number(value), height, confirmations)
    .run();
}

async function pushPendingUtxosToSentio(db, env) {
  const { results: pending } = await db
    .prepare(`SELECT * FROM doge_utxos WHERE sentio_synced = 0 LIMIT 200`)
    .all();

  for (const utxo of pending) {
    const body = {
      // Real event shape reflecting the actual UTXO row — no synthetic fields.
      distinctId: `${utxo.txid}:${utxo.vout}`,
      eventName: "doge_utxo_observed",
      attributes: {
        txid: utxo.txid,
        vout: utxo.vout,
        address: utxo.address,
        valueSats: utxo.value_sats,
        height: utxo.height,
        confirmations: utxo.confirmations,
      },
      timestamp: new Date().toISOString(),
    };

    const res = await fetch(env.SENTIO_INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": env.SENTIO_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`Sentio push failed for ${utxo.txid}:${utxo.vout} — ${res.status} ${await res.text()}`);
      continue; // leave sentio_synced = 0, retry next run
    }

    await db
      .prepare(`UPDATE doge_utxos SET sentio_synced = 1 WHERE txid = ? AND vout = ?`)
      .bind(utxo.txid, utxo.vout)
      .run();
  }

  return pending.length;
}

async function runSyncCycle(env) {
  const { results: addresses } = await env.DB.prepare(
    `SELECT address FROM watched_addresses`
  ).all();

  let utxoCount = 0;

  for (const { address } of addresses) {
    const utxos = await fetchUtxosForAddress(address, env.ALCHEMY_API_KEY);
    for (const utxo of utxos) {
      await upsertUtxo(env.DB, address, utxo);
      utxoCount++;
    }
  }

  const pushedCount = await pushPendingUtxosToSentio(env.DB, env);

  return { addressesPolled: addresses.length, utxosSeen: utxoCount, pushedToSentio: pushedCount };
}

export default {
  // Manual trigger / health check: GET the worker to run a cycle on demand.
  async fetch(request, env) {
    try {
      const summary = await runSyncCycle(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response(`Sync error: ${err.message}`, { status: 500 });
    }
  },

  // Scheduled trigger — set the cron in wrangler.toml.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSyncCycle(env));
  },
};
