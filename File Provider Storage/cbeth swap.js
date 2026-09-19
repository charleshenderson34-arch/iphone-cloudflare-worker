/**
 * ETH <-> cbETH swaps via Uniswap V3 (SwapRouter02).
 *
 * All addresses below were independently verified against Etherscan/
 * multi-chain block explorers before use (see conversation for sources) —
 * not typed from memory. Same for every function selector: computed with a
 * from-scratch Keccak-256 implementation, validated against known-answer
 * tests, rather than assumed.
 *
 * DESIGN DECISION — this module never touches a private key:
 * every "build*" function below returns a plain { to, data, value } object.
 * You sign and send it yourself (e.g. with your own wallet/signer, a
 * hardware wallet, or a separate signing service). That's a deliberate
 * boundary, not a missing feature — a swap-building library has no business
 * asking for or handling your keys.
 *
 * Flow for ETH -> cbETH:
 *   1. wrap ETH into WETH      (WETH.deposit(), send value)
 *   2. approve the router      (WETH.approve(router, amountIn))
 *   3. swap WETH -> cbETH      (Router.exactInputSingle(...))
 *
 * Flow for cbETH -> ETH is the mirror image, ending in WETH.withdraw().
 */

export const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const CBETH_ADDRESS = "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704";
export const ROUTER02_ADDRESS = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
export const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
export const QUOTER_V2_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// Standard Uniswap V3 fee tiers, in the order we'll try them when looking
// for a pool: 0.05%, 0.3%, 1%, 0.01% (in hundredths of a bip).
export const FEE_TIERS = [500, 3000, 10000, 100];

const SELECTORS = {
  "getPool(address,address,uint24)": "0x1698ee82",
  "approve(address,uint256)": "0x095ea7b3",
  "allowance(address,address)": "0xdd62ed3e",
  "balanceOf(address)": "0x70a08231",
  "deposit()": "0xd0e30db0",
  "withdraw(uint256)": "0x2e1a7d4d",
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))": "0x04e45aaf",
  "quoteExactInputSingle((address,address,uint256,uint24,uint160))": "0xc6a5026a",
};

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  return json.result;
}

// ---- ABI encoding helpers (all types here are static, so no offset table
// is needed even for the single-tuple-argument functions) ----

function encAddress(addr) {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}
function encUint(value, bits = 256) {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("encUint: negative value");
  return v.toString(16).padStart(64, "0");
}

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

/**
 * Looks up the pool address for a token pair at a given fee tier via the
 * Factory. Returns null if no pool exists there (address(0)).
 */
export async function getPoolAddress(rpcUrl, tokenA, tokenB, fee) {
  const data =
    SELECTORS["getPool(address,address,uint24)"] +
    encAddress(tokenA) +
    encAddress(tokenB) +
    encUint(fee, 24);

  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: FACTORY_ADDRESS, data },
    "latest",
  ]);

  const addr = "0x" + result.slice(-40);
  return addr === "0x0000000000000000000000000000000000000000" ? null : addr;
}

/**
 * Tries each standard fee tier in order and returns the first pool that
 * exists for the pair. Does NOT check liquidity depth — just existence.
 * Returns { fee, poolAddress } or null if no pool exists at any tier.
 */
export async function findPool(rpcUrl, tokenA, tokenB, feeTiers = FEE_TIERS) {
  for (const fee of feeTiers) {
    const poolAddress = await getPoolAddress(rpcUrl, tokenA, tokenB, fee);
    if (poolAddress) return { fee, poolAddress };
  }
  return null;
}

/**
 * Gets a quote for swapping `amountIn` of tokenIn -> tokenOut at a given
 * fee tier, via QuoterV2 (a real on-chain simulation, not an estimate).
 * Returns the raw uint256 amountOut as a BigInt.
 */
export async function getQuote(rpcUrl, tokenIn, tokenOut, amountIn, fee) {
  const data =
    SELECTORS["quoteExactInputSingle((address,address,uint256,uint24,uint160))"] +
    encAddress(tokenIn) +
    encAddress(tokenOut) +
    encUint(amountIn) +
    encUint(fee, 24) +
    encUint(0, 160); // sqrtPriceLimitX96 = 0 (no limit)

  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: QUOTER_V2_ADDRESS, data },
    "latest",
  ]);

  // QuoterV2 returns (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
  const amountOutHex = "0x" + result.slice(2, 66);
  return hexToBigInt(amountOutHex);
}

/** Builds calldata to wrap native ETH into WETH. `value` carries the ETH. */
export function buildWrapEth(amountWei) {
  return {
    to: WETH_ADDRESS,
    data: SELECTORS["deposit()"],
    value: "0x" + BigInt(amountWei).toString(16),
  };
}

/** Builds calldata to unwrap WETH back into native ETH. */
export function buildUnwrapWeth(amountWei) {
  return {
    to: WETH_ADDRESS,
    data: SELECTORS["withdraw(uint256)"] + encUint(amountWei),
    value: "0x0",
  };
}

/** Builds an ERC20 approve() call. */
export function buildApprove(tokenAddress, spender, amountWei) {
  return {
    to: tokenAddress,
    data: SELECTORS["approve(address,uint256)"] + encAddress(spender) + encUint(amountWei),
    value: "0x0",
  };
}

/**
 * Builds the actual swap call against SwapRouter02.exactInputSingle.
 * amountOutMinimum should be derived from a fresh getQuote() call minus your
 * slippage tolerance — never pass 0 in production, or you accept any price.
 */
export function buildSwapExactInputSingle({
  tokenIn,
  tokenOut,
  fee,
  recipient,
  amountIn,
  amountOutMinimum,
  sqrtPriceLimitX96 = 0,
}) {
  const data =
    SELECTORS["exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"] +
    encAddress(tokenIn) +
    encAddress(tokenOut) +
    encUint(fee, 24) +
    encAddress(recipient) +
    encUint(amountIn) +
    encUint(amountOutMinimum) +
    encUint(sqrtPriceLimitX96, 160);

  return { to: ROUTER02_ADDRESS, data, value: "0x0" };
}

/**
 * Orchestrates a full ETH -> cbETH swap: finds the pool, gets a live quote,
 * applies slippage tolerance, and returns an ordered list of transactions
 * to sign and send (in order): wrap, approve, swap.
 *
 * slippageBps: 50 = 0.5% tolerance (adjust to taste; higher = more likely
 * to succeed in volatile conditions, lower = tighter price protection).
 */
export async function buildEthToCbethSwap(rpcUrl, { amountInWei, recipient, slippageBps = 50 }) {
  const pool = await findPool(rpcUrl, WETH_ADDRESS, CBETH_ADDRESS);
  if (!pool) throw new Error("No WETH/cbETH pool found at any standard fee tier");

  const quotedOut = await getQuote(rpcUrl, WETH_ADDRESS, CBETH_ADDRESS, amountInWei, pool.fee);
  const amountOutMinimum = (quotedOut * BigInt(10000 - slippageBps)) / 10000n;

  return {
    pool,
    quotedOut: quotedOut.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    steps: [
      buildWrapEth(amountInWei),
      buildApprove(WETH_ADDRESS, ROUTER02_ADDRESS, amountInWei),
      buildSwapExactInputSingle({
        tokenIn: WETH_ADDRESS,
        tokenOut: CBETH_ADDRESS,
        fee: pool.fee,
        recipient,
        amountIn: amountInWei,
        amountOutMinimum,
      }),
    ],
  };
}

/**
 * Orchestrates a full cbETH -> ETH swap: approve, swap to WETH, unwrap.
 */
export async function buildCbethToEthSwap(rpcUrl, { amountInWei, recipient, slippageBps = 50 }) {
  const pool = await findPool(rpcUrl, CBETH_ADDRESS, WETH_ADDRESS);
  if (!pool) throw new Error("No cbETH/WETH pool found at any standard fee tier");

  const quotedOut = await getQuote(rpcUrl, CBETH_ADDRESS, WETH_ADDRESS, amountInWei, pool.fee);
  const amountOutMinimum = (quotedOut * BigInt(10000 - slippageBps)) / 10000n;

  return {
    pool,
    quotedOut: quotedOut.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    steps: [
      buildApprove(CBETH_ADDRESS, ROUTER02_ADDRESS, amountInWei),
      buildSwapExactInputSingle({
        tokenIn: CBETH_ADDRESS,
        tokenOut: WETH_ADDRESS,
        fee: pool.fee,
        // swap output goes to the router's own WETH balance first when
        // unwrapping is next — recipient here should be the caller if you
        // plan to hold WETH, or you can route straight to yourself and
        // unwrap in a second step using your own WETH balance.
        recipient,
        amountIn: amountInWei,
        amountOutMinimum,
      }),
      buildUnwrapWeth(amountOutMinimum), // note: uses minimum, see caveat below
    ],
  };
}
