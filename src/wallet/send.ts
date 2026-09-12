import { VersionedTransaction, type Connection } from "@solana/web3.js";

/**
 * Sends signed wire bytes and waits for confirmation against the blockhash the
 * transaction was built with. Throws if it expires, or if it lands but
 * reverts - confirmTransaction resolves rather than rejects in that case.
 */
export async function sendAndConfirmRaw(
  connection: Connection,
  wireBytes: Uint8Array,
  blockhash: string,
  lastValidBlockHeight: number
): Promise<string> {
  const signature = await connection.sendRawTransaction(wireBytes, { maxRetries: 3, skipPreflight: false });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) {
    throw new Error(`tx ${signature} landed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number;
}

/** Simulates without signature checks, so a transaction can be validated against mainnet state before anything is signed. */
export async function simulateRaw(connection: Connection, wireBytes: Uint8Array): Promise<SimulationResult> {
  const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(wireBytes), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  return { err: value.err, logs: value.logs ?? [], unitsConsumed: value.unitsConsumed ?? 0 };
}
