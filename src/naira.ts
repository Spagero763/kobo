import { encodeFunctionData } from "viem";
import { erc20Abi, tag } from "./chain.js";
import { balanceOfToken, fromUnits, toUnits, type Token } from "./tokens.js";
import { chooseFeeCurrency, type FeeChoice } from "./feecurrency.js";

const GAS_LIMIT = 200_000n;

export interface NairaQuote {
  token: string;
  label: string;
  to: `0x${string}`;
  amount: string;
  arrives: string;
  /** What the fee will actually be taken in, chosen from what the sender holds. */
  feeCurrency: string;
  estimatedFee: string;
  maximumFee: string;
  senderNeedsCelo: false;
  balance: string;
  feeBalance: string;
  sufficient: boolean;
  gasSufficient: boolean;
  /** Every allowlisted token considered, so a caller can see why one was picked. */
  feeOptions: FeeChoice[];
  note?: string;
}

/**
 * What it costs to move either naira.
 *
 * The fee does not have to be the token being sent, only something Celo accepts
 * as gas. So the sender pays out of whatever allowlisted token they already
 * hold, which is the difference between a transfer they can make now and one
 * that needs them to acquire a second asset first. They still pay it
 * themselves; nothing here is sponsored.
 */
export async function quoteNaira(
  token: Token,
  from: `0x${string}`,
  to: `0x${string}`,
  amount: string,
): Promise<NairaQuote> {
  const value = toUnits(token, amount);
  if (value <= 0n) throw new Error("amount must be greater than zero");

  const [balance, fees] = await Promise.all([balanceOfToken(token, from), chooseFeeCurrency(from)]);

  // Prefer paying out of the token being sent when it can, so one balance
  // covers everything and the sender has one number to think about.
  const inSameToken = fees.considered.find(
    (f) => f.address.toLowerCase() === token.address.toLowerCase() && f.enough,
  );
  const chosen = inSameToken ?? fees.chosen;
  const sameToken = chosen?.address.toLowerCase() === token.address.toLowerCase();

  const maximum = chosen ? toUnits({ ...token, decimals: chosen.decimals }, chosen.maximum) : 0n;

  const sufficient = sameToken ? balance >= value + maximum : balance >= value;
  const quote: NairaQuote = {
    token: token.symbol,
    label: token.label,
    to,
    amount,
    arrives: amount,
    feeCurrency: chosen?.symbol ?? "none available",
    estimatedFee: chosen?.estimated ?? "0",
    maximumFee: chosen?.maximum ?? "0",
    senderNeedsCelo: false,
    balance: fromUnits(token, balance),
    feeBalance: chosen?.balance ?? "0",
    sufficient,
    gasSufficient: Boolean(chosen),
    feeOptions: fees.considered,
  };

  if (!chosen) {
    quote.note =
      "No token Celo accepts as gas was found in this wallet. Hold a little naira or cUSD and the fee comes out of that, never CELO.";
  } else if (!sameToken) {
    quote.note = `${token.symbol} cannot pay for its own gas on Celo, so the fee is taken from your ${chosen.symbol}. Still no CELO needed.`;
  }
  if (chosen && !sufficient) {
    quote.note = `Not enough ${token.symbol}. You are sending ${amount} and hold ${fromUnits(token, balance)}.`;
  }

  return quote;
}

/**
 * Calldata for the sender's own wallet.
 *
 * feeCurrency is resolved per sender rather than fixed, because a wallet
 * holding cNGN and cUSD but no NGNm can still pay, and hardcoding one token
 * would have failed at signing for a reason unrelated to what they hold.
 */
export async function buildNairaTransfer(token: Token, to: `0x${string}`, amount: string, from?: `0x${string}`) {
  let feeCurrency = token.address;

  if (from) {
    const fees = await chooseFeeCurrency(from);
    const inSameToken = fees.considered.find(
      (f) => f.address.toLowerCase() === token.address.toLowerCase() && f.enough,
    );
    const chosen = inSameToken ?? fees.chosen;
    if (!chosen) {
      throw new Error(
        "No token Celo accepts as gas was found in this wallet. Hold a little naira or cUSD and the fee comes out of that.",
      );
    }
    feeCurrency = chosen.address;
  }

  return {
    to: token.address,
    data: tag(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, toUnits(token, amount)],
      }),
    ),
    feeCurrency,
    gas: `0x${GAS_LIMIT.toString(16)}`,
  };
}
