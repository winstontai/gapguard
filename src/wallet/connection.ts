import { Connection } from "@solana/web3.js";
import { config } from "../config.js";

let cachedConnection: Connection | null = null;

export function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(config.SOLANA_RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: config.SOLANA_WS_URL,
    });
  }
  return cachedConnection;
}
