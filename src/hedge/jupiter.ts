import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sendAndConfirmRaw } from "../wallet/send.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  /** Full quote response, passed back into /swap verbatim - Jupiter requires the exact object. */
  raw: unknown;
}

function jupiterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.JUPITER_API_KEY) headers["x-api-key"] = config.JUPITER_API_KEY;
  return headers;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
  slippageBps = 50
): Promise<JupiterQuote> {
  const url = new URL(`${config.JUPITER_SWAP_BASE_URL}/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountAtomic.toString());
  url.searchParams.set("slippageBps", String(slippageBps));

  const res = await fetch(url, { headers: jupiterHeaders() });
  if (!res.ok) {
    throw new Error(`Jupiter quote failed (${res.status}): ${await res.text()}`);
  }
  const raw = (await res.json()) as Record<string, string>;
  const inputMintOut = raw.inputMint;
  const inAmount = raw.inAmount;
  const outputMintOut = raw.outputMint;
  const outAmount = raw.outAmount;
  const otherAmountThreshold = raw.otherAmountThreshold;
  const priceImpactPct = raw.priceImpactPct;
  if (!inputMintOut || !inAmount || !outputMintOut || !outAmount || !otherAmountThreshold) {
    throw new Error(`unexpected Jupiter quote shape: ${JSON.stringify(raw)}`);
  }

  return {
    inputMint: inputMintOut,
    inAmount,
    outputMint: outputMintOut,
    outAmount,
    otherAmountThreshold,
    priceImpactPct: priceImpactPct ?? "0",
    raw,
  };
}

export interface SwapResult {
  signature: string;
}

/** Builds, signs, sends, and confirms a swap for the given quote. Caller must have already checked RiskLimits. */
export async function executeSwap(connection: Connection, keypair: Keypair, quote: JupiterQuote): Promise<SwapResult> {
  const res = await fetch(`${config.JUPITER_SWAP_BASE_URL}/swap`, {
    method: "POST",
    headers: jupiterHeaders(),
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) {
    throw new Error(`Jupiter swap build failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { swapTransaction?: string };
  if (!body.swapTransaction) {
    throw new Error(`unexpected Jupiter swap response: ${JSON.stringify(body)}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
  // Jupiter stamps the transaction with a mainnet blockhash. Re-stamp it with one from the RPC we
  // actually send to: fresher on mainnet, and required when pointed at a local fork.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  tx.sign([keypair]);

  const signature = await sendAndConfirmRaw(connection, tx.serialize(), blockhash, lastValidBlockHeight);

  logger.info({ signature }, "swap confirmed");
  return { signature };
}
