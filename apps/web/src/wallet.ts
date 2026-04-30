import sdk from "@farcaster/miniapp-sdk";

const BASE_CHAIN_ID_HEX = "0x2105"; // 8453

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

async function getProvider(): Promise<Eip1193Provider> {
  const provider = (await sdk.wallet.getEthereumProvider()) as Eip1193Provider | null;
  if (!provider) throw new Error("no wallet provider");
  return provider;
}

async function ensureBaseChain(provider: Eip1193Provider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: BASE_CHAIN_ID_HEX,
          chainName: "Base",
          rpcUrls: ["https://mainnet.base.org"],
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          blockExplorerUrls: ["https://basescan.org"],
        },
      ],
    });
  }
}

export type TreasuryPaymentArgs = {
  treasury: string;
  amountWei: string;
};

// Simple ETH transfer to the treasury for the exact intent-bound amount. No
// calldata: smart-wallet implementations (Farcaster's embedded wallet
// included) sometimes drop or rewrite `data` on plain transfers, which would
// silently zero out the value. The payment is bound to the user's fid (and
// the chosen pack) via the unique amount_wei the server issues per intent.
export async function payTreasury({ treasury, amountWei }: TreasuryPaymentArgs): Promise<string> {
  const provider = await getProvider();
  await ensureBaseChain(provider);

  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  let from = accounts?.[0];
  if (!from) {
    const requested = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    from = requested?.[0];
  }
  if (!from) throw new Error("no wallet account");

  const valueHex = "0x" + BigInt(amountWei).toString(16);

  const txHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: treasury,
        value: valueHex,
      },
    ],
  })) as string;

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("invalid tx hash returned");
  }
  return txHash;
}
