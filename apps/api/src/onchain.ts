import { createPublicClient, http, isAddress, type Hex } from "viem";
import { base } from "viem/chains";

const TREASURY = process.env.TREASURY_ADDRESS;
const RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const MIN_CONFIRMATIONS = BigInt(process.env.UNDO_MIN_CONFIRMATIONS ?? "1");

if (!TREASURY || !isAddress(TREASURY)) {
  throw new Error("TREASURY_ADDRESS is required and must be a valid address");
}

export const treasuryAddress = TREASURY;
const treasuryLower = TREASURY.toLowerCase();

export const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

export type VerifiedPayment = {
  amountWei: bigint;
  blockNumber: number;
};

// Verifies a tx pays the treasury with at least `minValueWei`. Fid binding
// is done outside this function via a server-generated intent: the exact
// `tx.value` encodes the intent id (base_price + nonce), and the server
// looks up which fid (and which pack) that nonce belongs to. We can't bind
// fid through calldata because some smart-wallet implementations (notably
// the Farcaster embedded wallet) drop or rewrite calldata on simple
// transfers.
export async function verifyTreasuryPayment(
  txHashRaw: string,
  minValueWei: bigint
): Promise<VerifiedPayment> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHashRaw)) {
    throw new Error("invalid tx hash format");
  }
  const txHash = txHashRaw.toLowerCase() as Hex;

  const [tx, receipt, head] = await Promise.all([
    client.getTransaction({ hash: txHash }),
    client.getTransactionReceipt({ hash: txHash }),
    client.getBlockNumber(),
  ]);

  if (receipt.status !== "success") throw new Error("tx reverted");
  if (head - receipt.blockNumber < MIN_CONFIRMATIONS) {
    throw new Error("not enough confirmations");
  }
  if (!tx.to || tx.to.toLowerCase() !== treasuryLower) {
    throw new Error("wrong recipient");
  }
  if (tx.value < minValueWei) {
    throw new Error("insufficient value");
  }

  return { amountWei: tx.value, blockNumber: Number(receipt.blockNumber) };
}
