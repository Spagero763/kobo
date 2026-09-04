import { encodeFunctionData, formatUnits, isAddress, parseUnits } from "viem";
import { NGNM } from "./config.js";
import { account, canPayGasWith, erc20Abi, feeParams, gasPrice, publicClient, tag, walletClient } from "./chain.js";

export interface Quote {
  token: "NGNm";
  to: `0x${string}`;
  amount: string;
  arrives: string;
  feeCurrency: "NGNm";
  estimatedFee: string;
  maximumFee: string;
  senderNeedsCelo: false;
  balance: string;
  sufficient: boolean;
}

// Measured on mainnet: a tagged transfer paying its fee in NGNm burns ~98k,
// well above a plain ERC-20 transfer, because the fee itself moves as token
// transfers. The limit is headroom over that so a send cannot run out.
const GAS_LIMIT = 200_000n;
const GAS_USED = 100_000n;

/**
 * What a transfer costs right now, with no wallet and no address. The fee does
 * not depend on who is sending or how much, so there is no reason to make
 * someone connect a wallet before they can find out what they would be paying.
 */
export async function cost(amount = "5000") {
  const [{ anchor, tip }, accepted] = await Promise.all([gasPrice(NGNM), canPayGasWith(NGNM)]);
  const estimatedFee = (anchor + tip) * GAS_USED;
  const worstCase = (anchor * 2n + tip) * GAS_LIMIT;
  return {
    example: amount,
    arrives: amount,
    feeCurrency: "NGNm" as const,
    estimatedFee: formatUnits(estimatedFee, 18),
    maximumFee: formatUnits(worstCase, 18),
    total: formatUnits(parseUnits(amount, 18) + estimatedFee, 18),
    senderNeedsCelo: false,
    nairaAcceptedAsGas: accepted,
  };
}

export async function balanceOf(address: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: NGNM,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

/**
 * What the sender is committing to, before anything is signed. A naira transfer
 * costs naira, so the fee is quoted in the asset being sent rather than in a
 * second token the sender does not hold.
 */
export async function quote(from: `0x${string}`, to: string, amount: string): Promise<Quote> {
  if (!isAddress(to)) throw new Error("recipient is not a valid address");
  // Checked before parsing, so a bad amount is answered in Kobo's own words
  // rather than by leaking whatever the decimal parser threw.
  if (!/^\d*\.?\d+$/.test(amount.trim())) {
    throw new Error("amount must be a number, like 5000 or 1500.50");
  }
  const value = parseUnits(amount, 18);
  if (value <= 0n) throw new Error("amount must be greater than zero");

  if (!(await canPayGasWith(NGNM))) {
    throw new Error("NGNm is not currently an accepted fee currency on Celo");
  }

  const [balance, { anchor, tip }] = await Promise.all([balanceOf(from), gasPrice(NGNM)]);
  const estimatedFee = (anchor + tip) * GAS_USED;
  const worstCase = (anchor * 2n + tip) * GAS_LIMIT;

  return {
    token: "NGNm",
    to: to as `0x${string}`,
    amount: formatUnits(value, 18),
    arrives: formatUnits(value, 18),
    feeCurrency: "NGNm",
    estimatedFee: formatUnits(estimatedFee, 18),
    maximumFee: formatUnits(worstCase, 18),
    senderNeedsCelo: false,
    balance: formatUnits(balance, 18),
    // Checked against the ceiling, not the estimate, so a busy block cannot
    // turn a quote that said yes into a transfer that fails.
    sufficient: balance >= value + worstCase,
  };
}

/**
 * Calldata for the sender's own wallet to sign. Kobo never holds or moves a
 * user's money: the user signs, so the transfer is theirs and the fee currency
 * is set on their transaction.
 */
export function buildTransfer(to: `0x${string}`, amount: string) {
  return {
    to: NGNM,
    data: tag(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, parseUnits(amount, 18)],
      }),
    ),
    feeCurrency: NGNM,
    gas: `0x${GAS_LIMIT.toString(16)}`,
  };
}

/** Sends from Kobo's own wallet. Used by the agent side, not by people. */
export async function send(to: `0x${string}`, amount: string): Promise<string> {
  const wallet = walletClient();
  const hash = await wallet.sendTransaction({
    to: NGNM,
    data: tag(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, parseUnits(amount, 18)],
      }),
    ),
    account: account(),
    chain: wallet.chain,
    ...(await feeParams(NGNM, GAS_LIMIT)),
  } as Parameters<typeof wallet.sendTransaction>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  // A mined transaction is not a successful one. Without this a revert returns
  // a hash and reads as a completed transfer.
  if (receipt.status !== "success") throw new Error("the transfer reverted onchain");
  return hash;
}
