import { encodeFunctionData } from "viem";
import { NGNM } from "./config.js";
import { erc20Abi, gasPrice, tag } from "./chain.js";
import { balanceOfToken, fromUnits, TOKENS, toUnits, type Token } from "./tokens.js";

// A plain ERC-20 transfer paying its fee in a different token. Measured on
// mainnet for NGNm; cNGN is a comparable transfer so the same figure holds.
const GAS_LIMIT = 200_000n;
const GAS_USED = 100_000n;

export interface NairaQuote {
  token: string;
  label: string;
  to: `0x${string}`;
  amount: string;
  arrives: string;
  /** Always NGNm: it is the only naira Celo accepts as gas. */
  feeCurrency: "NGNm";
  estimatedFee: string;
  maximumFee: string;
  senderNeedsCelo: false;
  balance: string;
  gasBalance: string;
  sufficient: boolean;
  gasSufficient: boolean;
  note?: string;
}

/**
 * What it costs to move either naira.
 *
 * The fee is quoted in NGNm whichever token is being sent, because that is the
 * only naira Celo will accept as gas. So a cNGN sender needs a small NGNm float
 * alongside their cNGN, and is told so here rather than at signing time.
 */
export async function quoteNaira(
  token: Token,
  from: `0x${string}`,
  to: `0x${string}`,
  amount: string,
): Promise<NairaQuote> {
  const value = toUnits(token, amount);
  if (value <= 0n) throw new Error("amount must be greater than zero");

  const gasToken = TOKENS.NGNm;
  const sameToken = token.address.toLowerCase() === gasToken.address.toLowerCase();

  const [balance, gasBalance, { anchor, tip }] = await Promise.all([
    balanceOfToken(token, from),
    sameToken ? Promise.resolve(0n) : balanceOfToken(gasToken, from),
    gasPrice(gasToken.address),
  ]);

  const estimatedFee = (anchor + tip) * GAS_USED;
  const worstCase = (anchor * 2n + tip) * GAS_LIMIT;

  // When the fee comes out of a different token, the amount is not competing
  // with it, so the balance only has to cover the transfer itself.
  const sufficient = sameToken ? balance >= value + worstCase : balance >= value;
  const gasSufficient = sameToken ? sufficient : gasBalance >= worstCase;

  const quote: NairaQuote = {
    token: token.symbol,
    label: token.label,
    to,
    amount,
    arrives: amount,
    feeCurrency: "NGNm",
    estimatedFee: fromUnits(gasToken, estimatedFee),
    maximumFee: fromUnits(gasToken, worstCase),
    senderNeedsCelo: false,
    balance: fromUnits(token, balance),
    gasBalance: sameToken ? fromUnits(token, balance) : fromUnits(gasToken, gasBalance),
    sufficient,
    gasSufficient,
  };

  if (!sameToken) {
    quote.note =
      "cNGN cannot pay for its own gas on Celo, so the fee is taken in NGNm. You need a small NGNm balance alongside your cNGN, but never any CELO.";
  }
  if (!gasSufficient) {
    quote.note = `Not enough NGNm to cover the fee. You need about ${fromUnits(gasToken, worstCase)} NGNm to send this.`;
  }

  return quote;
}

/** Calldata for the sender's own wallet. The fee currency is always NGNm. */
export function buildNairaTransfer(token: Token, to: `0x${string}`, amount: string) {
  return {
    to: token.address,
    data: tag(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, toUnits(token, amount)],
      }),
    ),
    feeCurrency: NGNM,
    gas: `0x${GAS_LIMIT.toString(16)}`,
  };
}
