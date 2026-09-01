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

const GAS_LIMIT = 120_000n;

// What a tagged ERC-20 transfer actually burns. The limit above is headroom so
// a send cannot fail for want of gas; quoting against it would overstate the
// fee roughly fourfold, and the sender is owed the real number.
const GAS_USED = 62_000n;

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
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return hash;
}
