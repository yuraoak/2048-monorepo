import {
  createPublicClient,
  http,
  isAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
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

// Thrown when the tx exists but isn't yet usable — not propagated to the
// node, not mined, or mined but short of MIN_CONFIRMATIONS. The caller should
// treat this as retryable (the client polls /buy until it clears) rather than
// a hard rejection. Distinct from terminal failures (reverted, wrong
// recipient, insufficient value) which must never be retried.
export class PaymentPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentPendingError";
  }
}

// Heuristic for retryable RPC failures (rate limit, 5xx, timeouts, network).
// Our own terminal checks throw plain Error("tx reverted" / "wrong recipient"
// / "insufficient value") which intentionally don't match here.
function isTransientRpcError(err: unknown): boolean {
  const s = (err instanceof Error ? `${err.name} ${err.message}` : String(err));
  return /rate limit|429|\b50[234]\b|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|fetch failed|HttpRequestError|TimeoutError/i.test(
    s
  );
}

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

  let tx, receipt, head;
  try {
    [tx, receipt, head] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
      client.getBlockNumber(),
    ]);
  } catch (err) {
    // The wallet returns the hash on submission, so /buy is typically called
    // before the tx is mined (or before this RPC node has seen it). Surface
    // that as retryable instead of a hard failure.
    if (
      err instanceof TransactionNotFoundError ||
      err instanceof TransactionReceiptNotFoundError
    ) {
      throw new PaymentPendingError("tx not yet mined");
    }
    // Rate limit / 5xx / timeout / network blip on the RPC: not the payment's
    // fault. Treat as retryable so a transient RPC error doesn't reject a real
    // payment — the client polls and the reconciler is the long-tail net.
    if (isTransientRpcError(err)) {
      throw new PaymentPendingError("rpc temporarily unavailable");
    }
    throw err;
  }

  if (receipt.status !== "success") throw new Error("tx reverted");
  if (head - receipt.blockNumber < MIN_CONFIRMATIONS) {
    throw new PaymentPendingError("not enough confirmations");
  }
  if (!tx.to || tx.to.toLowerCase() !== treasuryLower) {
    throw new Error("wrong recipient");
  }
  if (tx.value < minValueWei) {
    throw new Error("insufficient value");
  }

  return { amountWei: tx.value, blockNumber: Number(receipt.blockNumber) };
}
