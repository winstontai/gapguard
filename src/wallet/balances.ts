import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection.js";

/**
 * Raw base-unit balance across all of the owner's token accounts for a mint.
 * Raw, not UI amount: xStocks apply a dividend multiplier to their UI amount,
 * while Kamino and Jupiter both work in base units.
 */
export async function getRawTokenBalance(owner: PublicKey, mint: string): Promise<bigint> {
  const { value } = await getConnection().getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  return value.reduce((sum, { account }) => sum + BigInt(account.data.parsed.info.tokenAmount.amount as string), 0n);
}

export async function getSolBalance(owner: PublicKey): Promise<number> {
  return (await getConnection().getBalance(owner)) / 1e9;
}
