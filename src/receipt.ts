import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  isAddress,
  isHash,
  parseAbiItem,
  type Hash,
  type PublicClient,
} from "viem";
import { celo } from "viem/chains";
import { toDataSuffix } from "@celo/attribution-tags";
import { publicClient, readFresh } from "./chain.js";
import { config } from "./config.js";
import { TOKENS, feeAddressOf, toUnits, tokenBySymbol } from "./tokens.js";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";

// Where a fee paid in a token moves: the sequencer fee vault, the base fee
// recipient, and the holding address USD₮ pre-charges and refunds through.
// Those legs are ordinary transfers, not the payment.
const FEE_SINKS = new Set([
  "0x4200000000000000000000000000000000000011",
  "0xcd437749e43a154c07f3553504c68fbfd56b8778",
  "0x000000000000000000000000000000000ce106a5",
]);

// Some fallback nodes drop receipts for older blocks, which reported a settled
// payment as pending. Forno answers first.
const forno = createPublicClient({
  chain: celo,
  transport: http(config.celoRpc, { timeout: 15_000, retryCount: 2 }),
}) as PublicClient;
const read = <T>(fn: (c: PublicClient) => Promise<T>) => fn(forno).catch(() => fn(publicClient));

/** The chain could not be read. Not the payer's fault, so never charged. */
export class ChainUnavailable extends Error {}

const byAddress = new Map(Object.values(TOKENS).map((t) => [t.address.toLowerCase(), t]));
const feeSymbol = new Map(Object.values(TOKENS).map((t) => [feeAddressOf(t).toLowerCase(), t.symbol]));

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

export interface Expectation {
  to?: string;
  token?: string;
  amount?: string;
}

/**
 * Whether a payment really landed, read from the chain.
 *
 * Fake transfer alerts are an old trick: a screenshot, an SMS, or a hash that
 * looks right. Only transfers from the real token contracts are listed, so a
 * look-alike token named cNGN moves nothing here.
 */
export async function receipt(hash: string, expect: Expectation = {}) {
  if (!isHash(hash)) throw new Error("that is not a transaction hash. It should be 0x followed by 64 characters.");
  if (expect.to && !isAddress(expect.to)) throw new Error("to must be a valid address");
  if (expect.amount && !expect.token) throw new Error("say which token the amount is in, e.g. token=cNGN");

  const want = expect.token ? tokenBySymbol(expect.token) : null;
  if (expect.token && !want) {
    throw new Error(`unknown token ${expect.token}, expected one of ${Object.keys(TOKENS).join(", ")}`);
  }
  const wanted = want && expect.amount ? toUnits(want, expect.amount) : null;
  if (wanted !== null && wanted <= 0n) throw new Error("amount must be greater than zero");

  const tx = await readFresh(() => read((c) => c.getTransaction({ hash: hash as Hash })), 3).catch(() => null);
  if (!tx) {
    return {
      hash,
      found: false,
      paid: false,
      verdict: "No transaction with this hash exists on Celo. Treat the alert as fake and release nothing.",
    };
  }

  if (tx.blockNumber === null) {
    return {
      hash,
      found: true,
      status: "pending",
      paid: false,
      verdict: "Seen, but not confirmed yet. Wait for it before handing anything over.",
    };
  }

  const rc = await readFresh(() => read((c) => c.getTransactionReceipt({ hash: hash as Hash })), 4).catch(() => null);
  if (!rc) {
    throw new ChainUnavailable("The transaction is onchain but its receipt could not be read just now. Try again in a moment.");
  }

  const [block, latest] = await Promise.all([
    read((c) => c.getBlock({ blockNumber: rc.blockNumber })),
    read((c) => c.getBlockNumber()),
  ]);

  const transfers = rc.logs.flatMap((log) => {
    const token = byAddress.get(log.address.toLowerCase());
    if (!token) return [];
    try {
      const { args } = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
      if (FEE_SINKS.has(args.to.toLowerCase()) || FEE_SINKS.has(args.from.toLowerCase())) return [];
      if (args.from === ZERO || args.to === ZERO) return [];
      return [{ token: token.symbol, from: args.from, to: args.to, amount: formatUnits(args.value, token.decimals), raw: args.value }];
    } catch {
      return [];
    }
  });

  const feeCurrency = (tx as { feeCurrency?: string | null }).feeCurrency ?? null;
  const fee = rc.gasUsed * rc.effectiveGasPrice;
  const suffix = config.attributionTag ? toDataSuffix(config.attributionTag).slice(2).toLowerCase() : "";

  const ok = rc.status === "success";
  const out = {
    hash,
    found: true,
    status: ok ? "confirmed" : "failed",
    block: Number(rc.blockNumber),
    time: new Date(Number(block.timestamp) * 1000).toISOString(),
    confirmations: Number(latest - rc.blockNumber) + 1,
    from: tx.from,
    transfers: transfers.map(({ raw, ...t }) => t),
    fee: {
      currency: feeCurrency ? (feeSymbol.get(feeCurrency.toLowerCase()) ?? feeCurrency) : "CELO",
      amount: formatUnits(fee, 18),
    },
    celoSpentOnFee: feeCurrency ? "0" : formatUnits(fee, 18),
    sentWithKobo: Boolean(suffix) && tx.input.toLowerCase().endsWith(suffix),
    paid: false,
    received: undefined as string | undefined,
    verdict: "",
  };

  if (!ok) {
    out.verdict = "This transaction failed onchain. No money moved.";
    return out;
  }

  if (!expect.to) {
    out.paid = transfers.length > 0;
    out.verdict = transfers.length
      ? `Confirmed. ${transfers.map((t) => `${t.amount} ${t.token} to ${short(t.to)}`).join(", ")}.`
      : "Confirmed, but it moved none of the naira or dollar tokens Kobo recognises.";
    return out;
  }

  const legs = transfers.filter(
    (t) => t.to.toLowerCase() === expect.to!.toLowerCase() && (!want || t.token === want.symbol),
  );
  const received = legs.reduce((sum, t) => sum + t.raw, 0n);
  const unit = want ?? (legs[0] ? tokenBySymbol(legs[0].token) : null);
  out.received = unit ? formatUnits(received, unit.decimals) : "0";

  if (!legs.length) {
    out.verdict = `This transaction paid nothing${want ? ` in ${want.symbol}` : ""} to ${short(expect.to)}. Release nothing.`;
  } else if (wanted !== null && received < wanted) {
    out.verdict = `Short. ${out.received} ${unit!.symbol} arrived, not ${expect.amount}.`;
  } else {
    out.paid = true;
    out.verdict = `Paid. ${out.received} ${unit!.symbol} reached ${short(expect.to)}, ${out.confirmations} confirmations.`;
  }
  return out;
}
