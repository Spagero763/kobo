import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { MENTO_CURRENCIES, NGNM, PAYOUT } from "./config.js";
import { erc20Abi, gasPrice, publicClient } from "./chain.js";
import { findPool, quoteSwap } from "./swap.js";

const payoutAbi = [
  {
    type: "function",
    name: "send",
    stateMutability: "nonpayable",
    inputs: [
      { name: "exchangeProvider", type: "address" },
      { name: "exchangeId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

// Measured on mainnet. A swap plus two transfers burns roughly five times what
// a plain transfer costs, and the sender is owed that number before signing
// rather than after.
const CROSS_GAS = 470_000n;
const APPROVE_GAS = 60_000n;
const GAS_LIMIT = 800_000n;

// Below this, the fixed gas cost is a large enough share of the transfer that
// sending naira directly is almost always the better answer.
const POOR_VALUE_RATIO = 0.05;

export function currencyBySymbol(symbol: string): { symbol: string; address: `0x${string}` } | null {
  const found = Object.entries(MENTO_CURRENCIES).find(
    ([s]) => s.toLowerCase() === symbol.toLowerCase(),
  );
  return found ? { symbol: found[0], address: found[1] as `0x${string}` } : null;
}

export interface CrossQuote {
  from: "NGNm";
  to: string;
  amount: string;
  arrives: string;
  rate: string;
  feeCurrency: "NGNm";
  estimatedFee: string;
  feeSharePct: string;
  approvalFee: string;
  senderNeedsCelo: false;
  minimumReceived: string;
  slippagePct: number;
  balance?: string;
  sufficient?: boolean;
  advice?: string;
}

/**
 * What a cross-currency send really costs. The fee is fixed rather than
 * proportional, so it is quoted as a share of the amount too: 10 naira is
 * nothing on a remittance and a fifth of a 50 naira transfer.
 */
export async function crossQuote(
  toSymbol: string,
  amountNaira: string,
  sender?: `0x${string}`,
  slippagePct = 1,
): Promise<CrossQuote> {
  const currency = currencyBySymbol(toSymbol);
  if (!currency) throw new Error(`unknown currency ${toSymbol}`);
  if (currency.address.toLowerCase() === NGNM.toLowerCase()) {
    throw new Error("that is naira already, use a plain transfer");
  }

  const amountIn = parseUnits(amountNaira, 18);
  if (amountIn <= 0n) throw new Error("amount must be greater than zero");

  const pool = await findPool(NGNM, currency.address);
  if (!pool) throw new Error(`no Mento pool between NGNm and ${currency.symbol}`);

  const out = await quoteSwap(NGNM, currency.address, amountIn);
  if (out === null || out === 0n) throw new Error(`no price available for ${currency.symbol}`);

  const { anchor, tip } = await gasPrice(NGNM);
  const perGas = anchor + tip;
  const fee = CROSS_GAS * perGas;
  const approvalFee = APPROVE_GAS * perGas;
  const minOut = (out * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

  const feeShare = Number(formatUnits(fee, 18)) / Number(amountNaira);
  const rate = Number(formatUnits(out, 18)) / Number(amountNaira);

  const quote: CrossQuote = {
    from: "NGNm",
    to: currency.symbol,
    amount: amountNaira,
    arrives: formatUnits(out, 18),
    rate: rate.toPrecision(6),
    feeCurrency: "NGNm",
    estimatedFee: formatUnits(fee, 18),
    feeSharePct: (feeShare * 100).toFixed(2),
    approvalFee: formatUnits(approvalFee, 18),
    senderNeedsCelo: false,
    minimumReceived: formatUnits(minOut, 18),
    slippagePct,
  };

  if (feeShare > POOR_VALUE_RATIO) {
    quote.advice =
      `The fee is ${(feeShare * 100).toFixed(0)}% of this amount because a currency swap costs the ` +
      `same gas whatever the size. Send naira directly, or send a larger amount at once.`;
  }

  if (sender) {
    const balance = await publicClient.readContract({
      address: NGNM,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [sender],
    });
    quote.balance = formatUnits(balance, 18);
    quote.sufficient = balance >= amountIn + fee + approvalFee;
  }

  return quote;
}

/**
 * The two transactions a cross-currency send needs. The approval is for exactly
 * this amount and is consumed by the send, so no standing allowance is left
 * behind for the contract to draw on later.
 */
export async function buildCrossSend(
  toSymbol: string,
  amountNaira: string,
  recipient: `0x${string}`,
  slippagePct = 1,
) {
  const currency = currencyBySymbol(toSymbol);
  if (!currency) throw new Error(`unknown currency ${toSymbol}`);

  const amountIn = parseUnits(amountNaira, 18);
  const pool = await findPool(NGNM, currency.address);
  if (!pool) throw new Error(`no Mento pool between NGNm and ${currency.symbol}`);

  const out = await quoteSwap(NGNM, currency.address, amountIn);
  if (out === null || out === 0n) throw new Error(`no price available for ${currency.symbol}`);
  const minOut = (out * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

  return {
    approve: {
      to: NGNM,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAYOUT, amountIn] }),
      feeCurrency: NGNM,
      gas: `0x${APPROVE_GAS.toString(16)}`,
    },
    send: {
      to: PAYOUT,
      data: encodeFunctionData({
        abi: payoutAbi,
        functionName: "send",
        args: [pool.provider, pool.exchangeId, NGNM, currency.address, amountIn, minOut, recipient],
      }),
      feeCurrency: NGNM,
      gas: `0x${GAS_LIMIT.toString(16)}`,
    },
    expected: formatUnits(out, 18),
    minimumReceived: formatUnits(minOut, 18),
    note: "sign the approval first, then the send, both with the sender's own wallet",
  };
}
