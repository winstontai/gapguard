import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { logger } from "../logger.js";

let cachedKeypair: Keypair | null = null;

/**
 * Loads the operating hot wallet. Never logs the secret material - only the
 * resulting public key. Prefer WALLET_KEYPAIR_PATH (a JSON file kept outside
 * the repo) over WALLET_PRIVATE_KEY in .env where possible.
 */
export function loadKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;

  if (config.WALLET_KEYPAIR_PATH) {
    const raw = readFileSync(config.WALLET_KEYPAIR_PATH, "utf-8");
    const secretKey = Uint8Array.from(JSON.parse(raw) as number[]);
    cachedKeypair = Keypair.fromSecretKey(secretKey);
  } else if (config.WALLET_PRIVATE_KEY) {
    cachedKeypair = Keypair.fromSecretKey(bs58.decode(config.WALLET_PRIVATE_KEY));
  } else {
    throw new Error("No wallet configured: set WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH");
  }

  logger.info({ pubkey: cachedKeypair.publicKey.toBase58() }, "wallet loaded");
  return cachedKeypair;
}
