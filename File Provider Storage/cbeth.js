/**
 * cbETH (Coinbase Wrapped Staked ETH) — read/watch logic.
 *
 * Official contract (Ethereum mainnet): 0xBe9895146f7AF43049ca1c1AE358B0541Ea49704
 * Source: https://github.com/coinbase/wrapped-tokens-os
 *         contracts/wrapped-tokens/staking/StakedTokenV1.sol
 *
 * IMPORTANT — no permissionless wrap/unwrap exists:
 * cbETH is minted/burned only by Coinbase's MinterForwarder contract, which is
 * gated to Coinbase-controlled addresses (see MinterForwarder.sol / the
 * OpenZeppelin audit of this codebase). There is no public "wrap()" function
 * you or anyone else can call to mint cbETH from ETH — you only get cbETH by
 * staking through Coinbase's own product, or by buying it on the open market
 * (DEX/CEX). This module intentionally does NOT include a wrap/unwrap
 * function, because writing one would either be a no-op or would misleadingly
 * imply a capability that doesn't exist on this contract.
 *
 * What this module DOES do, all against real on-chain state:
 *  - read the live cbETH:ETH exchange rate
 *  - read an address's cbETH balance (raw + converted to underlying ETH)
 *  - decode Mint/Burn event logs from eth_getLogs for a block range
 *
 * No dependencies — plain JSON-RPC over fetch, so this drops into a
 * Cloudflare Worker (or Node) without needing ethers/viem.
 */

export const CBETH_ADDRESS = "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704";
export const CBETH_DECIMALS = 18;

// Function selectors (first 4 bytes of keccak256 of the signature).
// Precomputed so we don't need a keccak library at runtime.
const SELECTORS = {
  "exchangeRate()": "0x3ba0b9a9",
  "balanceOf(address)": "0x70a08231",
  "decimals()": "0x313ce567",
  "totalSupply()": "0x18160ddd",
};

// Event topic0 hashes = keccak256 of the event signature string.
// cbETH inherits these from the underlying FiatTokenV1 (Centre/USDC-style)
// base contract — StakedTokenV1.sol itself adds no new events beyond
// OracleUpdated/ExchangeRateUpdated:
//   event Mint(address indexed minter, address indexed to, uint256 amount)
//   event Burn(address indexed burner, uint256 amount)
// These were computed with a from-scratch Keccak-256 implementation and
// cross-checked against Python's stdlib SHA3-256 (same permutation, only the
// padding byte differs) plus the well-known ERC20 Transfer() topic hash as a
// known-answer test, rather than typed from memory.
export const TOPICS = {
  Mint: "0xab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8",
  Burn: "0xcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5",
};

/**
 * Minimal JSON-RPC helper. Pass any Ethereum mainnet RPC URL you have
 * (Alchemy, Infura, a public endpoint, etc.) — same pattern as the Alchemy
 * fetch already used in the Doge indexer.
 */
async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`RPC HTTP error ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

function encodeAddressParam(address) {
  // left-pad a 20-byte address to a 32-byte word for calldata
  return address.toLowerCase().replace("0x", "").padStart(64, "0");
}

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

/**
 * Reads the current cbETH:ETH exchange rate directly from the contract.
 * The raw value is a fixed-point number scaled by 1e18, representing how
 * much underlying (staked) ETH one cbETH is worth right now.
 *
 * Returns both the raw uint256 (as a string, since it can exceed
 * Number precision) and a human-readable decimal string.
 */
export async function getExchangeRate(rpcUrl) {
  const raw = await rpcCall(rpcUrl, "eth_call", [
    { to: CBETH_ADDRESS, data: SELECTORS["exchangeRate()"] },
    "latest",
  ]);

  const rateWei = hexToBigInt(raw);
  const rateDecimal = formatUnits(rateWei, CBETH_DECIMALS);

  return { raw: rateWei.toString(), rate: rateDecimal };
}

/**
 * Reads an address's cbETH balance, both raw and human-readable, plus the
 * equivalent underlying ETH value using the current exchange rate.
 */
export async function getBalance(rpcUrl, address) {
  const [balRaw, exchangeRate] = await Promise.all([
    rpcCall(rpcUrl, "eth_call", [
      {
        to: CBETH_ADDRESS,
        data: SELECTORS["balanceOf(address)"] + encodeAddressParam(address),
      },
      "latest",
    ]),
    getExchangeRate(rpcUrl),
  ]);

  const balanceWei = hexToBigInt(balRaw);
  const balanceCbEth = formatUnits(balanceWei, CBETH_DECIMALS);

  // underlyingEth = balance * exchangeRate  (both scaled 1e18, so divide once)
  const underlyingWei = (balanceWei * BigInt(exchangeRate.raw)) / 10n ** 18n;
  const underlyingEth = formatUnits(underlyingWei, CBETH_DECIMALS);

  return {
    address,
    balanceRaw: balanceWei.toString(),
    balanceCbEth,
    exchangeRate: exchangeRate.rate,
    underlyingEth,
  };
}

/**
 * Fetches and decodes Mint/Burn events for a block range.
 * fromBlock/toBlock: hex strings ("0x..."), decimal numbers, or "latest".
 */
export async function getMintBurnEvents(rpcUrl, fromBlock, toBlock = "latest") {
  const toHex = (b) =>
    typeof b === "number" ? "0x" + b.toString(16) : b;

  const logs = await rpcCall(rpcUrl, "eth_getLogs", [
    {
      address: CBETH_ADDRESS,
      fromBlock: toHex(fromBlock),
      toBlock: toHex(toBlock),
      topics: [[TOPICS.Mint, TOPICS.Burn]],
    },
  ]);

  return logs.map((log) => decodeMintOrBurn(log));
}

function decodeMintOrBurn(log) {
  const isMint = log.topics[0].toLowerCase() === TOPICS.Mint.toLowerCase();

  if (isMint) {
    // Mint(address indexed minter, address indexed to, uint256 amount)
    const minter = "0x" + log.topics[1].slice(-40);
    const to = "0x" + log.topics[2].slice(-40);
    const amount = hexToBigInt(log.data);
    return {
      type: "Mint",
      minter,
      to,
      amount: amount.toString(),
      amountFormatted: formatUnits(amount, CBETH_DECIMALS),
      blockNumber: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
      logIndex: parseInt(log.logIndex, 16),
    };
  }

  // Burn(address indexed burner, uint256 amount)
  const burner = "0x" + log.topics[1].slice(-40);
  const amount = hexToBigInt(log.data);
  return {
    type: "Burn",
    burner,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, CBETH_DECIMALS),
    blockNumber: parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
  };
}

/** Formats a BigInt wei-style value with `decimals` decimal places, as a string. */
function formatUnits(value, decimals) {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const result = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${result}` : result;
}
