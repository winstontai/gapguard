import bs58 from "bs58";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type AddressesByLookupTableAddress,
  type TransactionSigner,
} from "@solana/kit";
import {
  DEFAULT_RECENT_SLOT_DURATION_MS,
  FloatRateReserveKind,
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID,
  U64_MAX,
  VanillaObligation,
  getCurrentLedgerInstant,
  type KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { config } from "../config.js";
import { getConnection } from "../wallet/connection.js";
import { loadKeypair } from "../wallet/keypair.js";
import { sendAndConfirmRaw, simulateRaw, type SimulationResult } from "../wallet/send.js";
import { USDC_MINT } from "./jupiter.js";

const rpc = createSolanaRpc(config.SOLANA_RPC_URL);
const EXTRA_COMPUTE_UNITS = 1_000_000;
// refreshAll() reloads every reserve; one hedge touches the market 3-5 times in a few seconds, which
// public RPC rate-limits. Reserve state that's seconds old is fine: each transaction refreshes the
// reserves on-chain, and obligations are always fetched fresh.
const MARKET_REFRESH_MS = 15_000;
// Address lookup table layout: metadata, then a packed array of 32-byte addresses.
const LUT_META_SIZE = 56;

let marketPromise: Promise<KaminoMarket> | null = null;
let lastRefreshTs = 0;

/** Kamino's xStocks lending market, loaded once and refreshed at most every MARKET_REFRESH_MS. */
async function getMarket(): Promise<KaminoMarket> {
  marketPromise ??= KaminoMarket.load(rpc, address(config.KAMINO_XSTOCKS_MARKET), DEFAULT_RECENT_SLOT_DURATION_MS)
    .then((market) => {
      if (!market) throw new Error(`Kamino market ${config.KAMINO_XSTOCKS_MARKET} not found`);
      lastRefreshTs = Date.now();
      return market;
    })
    .catch((err: unknown) => {
      marketPromise = null;
      throw err;
    });
  const market = await marketPromise;
  if (Date.now() - lastRefreshTs > MARKET_REFRESH_MS) {
    await market.refreshAll();
    lastRefreshTs = Date.now();
  }
  return market;
}

function reserveFor(market: KaminoMarket, mint: string): KaminoReserve {
  const reserve = market.getReserveByMintAndKind(address(mint), new FloatRateReserveKind());
  if (!reserve) throw new Error(`no Kamino reserve for mint ${mint} in the xStocks market`);
  return reserve;
}

export interface KaminoAccount {
  obligationExists: boolean;
  collateralUsd: number;
  debtUsdBorrowFactorAdjusted: number;
  ltv: number;
  liquidationLtv: number;
  /** Outstanding debt per requested xStock mint, in whole tokens. Zero debts are omitted. */
  debts: Map<string, number>;
}

async function readAccount(market: KaminoMarket, owner: string, xstockMints: string[]): Promise<KaminoAccount> {
  const obligation = await market.getObligationByWallet(address(owner), new VanillaObligation(PROGRAM_ID));
  if (!obligation) {
    return { obligationExists: false, collateralUsd: 0, debtUsdBorrowFactorAdjusted: 0, ltv: 0, liquidationLtv: 0, debts: new Map() };
  }

  const debts = new Map<string, number>();
  for (const mint of xstockMints) {
    const reserve = market.getReserveByMintAndKind(address(mint), new FloatRateReserveKind());
    if (!reserve) continue;
    // Whole tokens, unlike getLiquidityAvailableAmount() which is base units - checked against a live obligation.
    const qty = obligation.getBorrowAmountByReserve(reserve).toNumber();
    if (qty > 0) debts.set(mint, qty);
  }

  const s = obligation.refreshedStats;
  return {
    obligationExists: true,
    collateralUsd: s.userTotalCollateralDeposit.toNumber(),
    debtUsdBorrowFactorAdjusted: s.userTotalBorrowBorrowFactorAdjusted.toNumber(),
    ltv: s.loanToValue.toNumber(),
    liquidationLtv: s.liquidationLtv.toNumber(),
    debts,
  };
}

export async function getKaminoAccount(owner: string, xstockMints: string[]): Promise<KaminoAccount> {
  return readAccount(await getMarket(), owner, xstockMints);
}

export interface ShortContext {
  borrowable: boolean;
  notBorrowableReason?: string;
  /** What Kamino can lend right now, in whole tokens. */
  availableQty: number;
  /** Debt-side risk multiplier for this xStock against USDC collateral, e.g. 1.66 means $100 of debt counts as $166. */
  borrowFactor: number;
  account: KaminoAccount;
}

/** Everything needed to size or close a short on one xStock, from a single market refresh. */
export async function getShortContext(owner: string, xstockMint: string, decimals: number): Promise<ShortContext> {
  const market = await getMarket();
  const reserve = reserveFor(market, xstockMint);
  const cfg = reserve.state.config;
  const notBorrowableReason = cfg.borrowLimit.isZero()
    ? `${reserve.symbol} has borrowing disabled on Kamino`
    : cfg.borrowLimitOutsideElevationGroup.isZero()
      ? `${reserve.symbol} can only be borrowed inside an elevation group`
      : undefined;
  const { borrowFactor } = market.getMaxAndLiquidationLtvAndBorrowFactorForPair(
    reserveFor(market, USDC_MINT).address,
    reserve.address
  );

  return {
    borrowable: notBorrowableReason === undefined,
    notBorrowableReason,
    availableQty: reserve.getLiquidityAvailableAmount().toNumber() / 10 ** decimals,
    borrowFactor,
    account: await readAccount(market, owner, [xstockMint]),
  };
}

/** Kamino legs of a short. Amounts are integer base units; "all" repays or withdraws the full outstanding amount. */
export type KaminoOp =
  | { kind: "borrow"; xstockMint: string; qtyBase: bigint; depositUsdcBase: bigint }
  | { kind: "repay"; xstockMint: string; qtyBase: bigint | "all" }
  | { kind: "withdrawCollateral"; usdcBase: bigint | "all" };

async function buildAction(market: KaminoMarket, owner: TransactionSigner, op: KaminoOp): Promise<KaminoAction> {
  const existing = await market.getObligationByWallet(owner.address, new VanillaObligation(PROGRAM_ID));
  const common = {
    kaminoMarket: market,
    owner,
    obligation: existing ?? new VanillaObligation(PROGRAM_ID),
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    extraComputeBudget: EXTRA_COMPUTE_UNITS,
    includeAtaIxs: true,
    requestElevationGroup: false,
    // The per-user lookup table is a Kamino UI optimization. Skipping it avoids creating an account
    // that can't be used by the transaction creating it, and saves its rent.
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
    currentLedgerInstant: await getCurrentLedgerInstant(rpc),
  };
  const usdcReserve = reserveFor(market, USDC_MINT).address;

  switch (op.kind) {
    case "borrow": {
      const xReserve = reserveFor(market, op.xstockMint).address;
      return op.depositUsdcBase === 0n
        ? KaminoAction.buildBorrowTxns({ ...common, amount: op.qtyBase.toString(), reserveAddress: xReserve })
        : KaminoAction.buildDepositAndBorrowTxns({
            ...common,
            depositAmount: op.depositUsdcBase.toString(),
            depositReserveAddress: usdcReserve,
            borrowAmount: op.qtyBase.toString(),
            borrowReserveAddress: xReserve,
          });
    }
    case "repay":
      return KaminoAction.buildRepayTxns({
        ...common,
        amount: op.qtyBase === "all" ? U64_MAX : op.qtyBase.toString(),
        reserveAddress: reserveFor(market, op.xstockMint).address,
      });
    case "withdrawCollateral":
      return KaminoAction.buildWithdrawTxns({
        ...common,
        amount: op.usdcBase === "all" ? U64_MAX : op.usdcBase.toString(),
        reserveAddress: usdcReserve,
      });
  }
}

/**
 * Lookup tables that already exist on-chain, decoded to their address lists.
 * Kamino can list a table it schedules for creation inside this same transaction, and a table
 * can't be used by the transaction that creates it - so anything missing is simply skipped.
 */
async function fetchExistingLuts(addresses: Address[]): Promise<AddressesByLookupTableAddress> {
  if (addresses.length === 0) return {};
  const { value } = await rpc.getMultipleAccounts(addresses, { encoding: "base64" }).send();

  const tables: AddressesByLookupTableAddress = {};
  value.forEach((account, i) => {
    const lutAddress = addresses[i];
    if (!account || !lutAddress) return;
    const raw = Buffer.from(account.data[0], "base64");
    if (raw.length <= LUT_META_SIZE) return;

    const entries: Address[] = [];
    for (let offset = LUT_META_SIZE; offset + 32 <= raw.length; offset += 32) {
      entries.push(address(bs58.encode(raw.subarray(offset, offset + 32))));
    }
    tables[lutAddress] = entries;
  });
  return tables;
}

interface BuiltTx {
  wireBytes: Uint8Array;
  blockhash: string;
  lastValidBlockHeight: number;
  labels: string[];
}

async function buildTx(action: KaminoAction, feePayer: TransactionSigner, sign: boolean): Promise<BuiltTx> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const lutAddresses = await fetchExistingLuts(action.luts);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latest, tx),
    (tx) => appendTransactionMessageInstructions(KaminoAction.actionToIxs(action), tx),
    (tx) => compressTransactionMessageUsingAddressLookupTables(tx, lutAddresses)
  );
  const tx = sign ? await signTransactionMessageWithSigners(message) : compileTransaction(message);

  return {
    wireBytes: Buffer.from(getBase64EncodedWireTransaction(tx), "base64"),
    blockhash: latest.blockhash,
    lastValidBlockHeight: Number(latest.lastValidBlockHeight),
    labels: KaminoAction.actionToIxLabels(action),
  };
}

/**
 * Builds the op for any owner address and simulates it with signature checks
 * off - validates the full instruction set against live state without a
 * funded wallet or a private key.
 */
export async function simulateKaminoOp(
  ownerAddress: string,
  op: KaminoOp
): Promise<SimulationResult & { labels: string[]; txBytes: number }> {
  const owner = createNoopSigner(address(ownerAddress));
  const built = await buildTx(await buildAction(await getMarket(), owner, op), owner, false);
  const sim = await simulateRaw(getConnection(), built.wireBytes);
  return { ...sim, labels: built.labels, txBytes: built.wireBytes.length };
}

let signerPromise: Promise<TransactionSigner> | null = null;

// 0x1781 = ObligationStale (6017), 0x1797 = PriceTooOld (6039). Kamino won't act on a price it
// considers stale, which in practice means the xStock oracle hasn't updated recently.
const STALE_PRICE_ERROR = /PriceTooOld|ObligationStale|0x1781|0x1797/i;

function explainKaminoError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (STALE_PRICE_ERROR.test(message)) {
    return new Error(
      `Kamino rejected the transaction because its price feed is stale, so it won't lend against it right now. ` +
        `Outside US market hours Kamino only accepts xStock prices within a band of the last close, which is the usual cause. Details: ${message.slice(0, 160)}`
    );
  }
  return err instanceof Error ? err : new Error(message);
}

/** Signs and sends the op from the hot wallet. Caller must have already passed RiskLimits. */
export async function executeKaminoOp(op: KaminoOp): Promise<string> {
  signerPromise ??= createKeyPairSignerFromBytes(loadKeypair().secretKey);
  const signer = await signerPromise;
  const built = await buildTx(await buildAction(await getMarket(), signer, op), signer, true);
  try {
    return await sendAndConfirmRaw(getConnection(), built.wireBytes, built.blockhash, built.lastValidBlockHeight);
  } catch (err) {
    throw explainKaminoError(err);
  }
}
