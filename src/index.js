import { createWalletClient, http, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC_ADDRESS = '0x21117071756a9789c45ade0cfb40e7bce62ce9f0'

export default {
  async fetch(request, env) {
    const manifest = await env.NEXUS_ASSETS.get("manifest.json", { type: "json" });
    const account = privateKeyToAccount(env.PRIVATE_KEY);
    const client = createWalletClient({ 
      account, 
      chain: base, 
      transport: http(env.RPC_URL) 
    });

    const amount = parseUnits(manifest.transfer.amount, 6);
    
    const hash = await client.writeContract({
      address: USDC_ADDRESS,
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [manifest.transfer.to, amount]
    });

    manifest.status = "SYNCED";
    manifest.last_tx = hash;
    await env.NEXUS_ASSETS.put("manifest.json", JSON.stringify(manifest, null, 2));
    
    return new Response(JSON.stringify({ status: "SUCCESS", hash }));
  }
};

