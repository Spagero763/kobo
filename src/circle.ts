import { encodeFunctionData, formatUnits, getAddress, keccak256, parseAbiItem, parseUnits, toHex } from "viem";
import { CIRCLES, CIRCLES_DEPLOYED_AT, NGNM } from "./config.js";
import { publicClient, readFresh, tag } from "./chain.js";

// Public nodes cap how many blocks one eth_getLogs may span, and they disagree
// about the limit. Start optimistic and shrink on rejection rather than pinning
// a number that breaks the moment a node is swapped in.
const LOG_WINDOW_START = 4_000n;
const LOG_WINDOW_MIN = 250n;

/** Celo produces roughly a block a second, so a timestamp maps to a block. */
function blockAt(timestamp: number): bigint {
  const delta = BigInt(Math.max(0, timestamp - CIRCLES_DEPLOYED_AT.timestamp));
  return CIRCLES_DEPLOYED_AT.block + delta;
}

const rangeTooLarge = (e: unknown) =>
  /range is too large|block range|too many blocks|limit exceeded|query returned more than/i.test(
    String((e as Error)?.message ?? e),
  );

async function logsInRange<T>(
  from: bigint,
  to: bigint,
  query: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let window = LOG_WINDOW_START;
  let start = from;

  while (start <= to) {
    const end = start + window - 1n > to ? to : start + window - 1n;
    try {
      out.push(...(await query(start, end)));
      start = end + 1n;
    } catch (e) {
      if (rangeTooLarge(e) && window > LOG_WINDOW_MIN) {
        window /= 2n;
        continue;
      }
      throw e;
    }
  }
  return out;
}

export const circlesAbi = [
  { type: "function", name: "circleId", stateMutability: "pure", inputs: [{ name: "organiser", type: "address" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "create", stateMutability: "nonpayable", inputs: [{ name: "salt", type: "bytes32" }, { name: "amount", type: "uint128" }, { name: "interval", type: "uint64" }, { name: "name", type: "string" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "join", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "name", type: "string" }], outputs: [] },
  { type: "function", name: "start", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "isMember", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }, { name: "", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "memberCount", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getCircle", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "organiser", type: "address" },
      { name: "amount", type: "uint128" },
      { name: "interval", type: "uint64" },
      { name: "startedAt", type: "uint64" },
      { name: "members", type: "address[]" },
    ],
  },
  { type: "function", name: "currentRound", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "round", type: "uint256" }, { name: "recipient", type: "address" }] },
  { type: "function", name: "dues", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "member", type: "address" }], outputs: [{ name: "owed", type: "uint256" }, { name: "recipient", type: "address" }, { name: "round", type: "uint256" }] },
  { type: "event", name: "Created", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "organiser", type: "address", indexed: true }, { name: "amount", type: "uint128" }, { name: "interval", type: "uint64" }, { name: "name", type: "string" }] },
  { type: "event", name: "Joined", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "member", type: "address", indexed: true }, { name: "name", type: "string" }] },
] as const;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const joinedEvent = parseAbiItem(
  "event Joined(bytes32 indexed id, address indexed member, string name)",
);

export interface CircleView {
  id: `0x${string}`;
  organiser: `0x${string}`;
  amount: string;
  interval: number;
  startedAt: number;
  started: boolean;
  members: { address: `0x${string}`; name: string }[];
  pot: string;
  round: number;
  recipient: `0x${string}` | null;
  roundsTotal: number;
}

/** Names live in Joined events rather than storage, which keeps joining cheap. */
async function namesFor(id: `0x${string}`): Promise<Map<string, string>> {
  const head = await publicClient.getBlockNumber();
  const logs = await logsInRange(CIRCLES_DEPLOYED_AT.block, head, (fromBlock, toBlock) =>
    publicClient.getLogs({ address: CIRCLES, event: joinedEvent, args: { id }, fromBlock, toBlock }),
  );
  const names = new Map<string, string>();
  for (const log of logs) {
    const { member, name } = log.args;
    if (member) names.set(member.toLowerCase(), name || "Member");
  }
  return names;
}

export async function getCircle(id: string): Promise<CircleView> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(id)) throw new Error("that is not a circle code");
  const key = id as `0x${string}`;

  const raw = (await readFresh(() =>
    publicClient.readContract({
      address: CIRCLES,
      abi: circlesAbi,
      functionName: "getCircle",
      args: [key],
    }),
  )) as readonly [`0x${string}`, bigint, bigint, bigint, readonly `0x${string}`[]];

  const [organiser, amount, interval, startedAt, members] = raw;
  const names = await namesFor(key);
  const started = startedAt > 0n;

  let round = 0;
  let recipient: `0x${string}` | null = null;
  if (started) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const elapsed = now - startedAt;
    const r = elapsed / interval;
    round = Number(r >= BigInt(members.length) ? BigInt(members.length - 1) : r);
    recipient = members[round] ?? null;
  }

  return {
    id: key,
    organiser,
    amount: formatUnits(amount, 18),
    interval: Number(interval),
    startedAt: Number(startedAt),
    started,
    members: members.map((a) => ({ address: a, name: names.get(a.toLowerCase()) ?? "Member" })),
    pot: formatUnits(amount * BigInt(Math.max(0, members.length - 1)), 18),
    round,
    recipient,
    roundsTotal: members.length,
  };
}

export interface Paid {
  from: `0x${string}`;
  round: number;
  txHash: string;
  amount: string;
}

/**
 * Contributions are read from NGNm transfer logs, not reported by the client.
 * A member is credited for a round when the chain shows them paying that
 * round's recipient at least the circle amount inside that round's window, so
 * nobody can mark themselves paid without actually paying.
 */
export async function contributions(c: CircleView): Promise<Paid[]> {
  if (!c.started) return [];
  const amount = parseUnits(c.amount, 18);
  const memberSet = new Set(c.members.map((m) => m.address.toLowerCase()));

  const head = await publicClient.getBlockNumber();
  const from = blockAt(c.startedAt);
  const logs = await logsInRange(from > head ? head : from, head, (fromBlock, toBlock) =>
    publicClient.getLogs({
      address: NGNM,
      event: transferEvent,
      args: { to: c.members.map((m) => m.address) },
      fromBlock,
      toBlock,
    }),
  );

  const startBlock = blockAt(c.startedAt);
  const paid: Paid[] = [];
  for (const log of logs) {
    const { from: sender, to, value } = log.args;
    if (!sender || !to || (value ?? 0n) < amount) continue;
    if (!memberSet.has(sender.toLowerCase())) continue;
    if (log.blockNumber < startBlock) continue;

    // Round derived from the block rather than fetching each block's timestamp,
    // which would be one extra call per transfer.
    const elapsed = Number(log.blockNumber - startBlock);
    const round = Math.min(Math.floor(elapsed / c.interval), c.roundsTotal - 1);
    if (c.members[round]?.address.toLowerCase() !== to.toLowerCase()) continue;

    paid.push({ from: sender, round, txHash: log.transactionHash, amount: formatUnits(value!, 18) });
  }
  return paid;
}

export interface Standing {
  address: `0x${string}`;
  name: string;
  paid: number;
  missed: number;
  onTime: number;
}

export function standings(c: CircleView, paid: Paid[]): Standing[] {
  return c.members.map((m) => {
    let done = 0;
    let missed = 0;
    for (let r = 0; r <= c.round; r++) {
      if (c.members[r]?.address.toLowerCase() === m.address.toLowerCase()) continue;
      const did = paid.some((p) => p.round === r && p.from.toLowerCase() === m.address.toLowerCase());
      if (did) done++;
      else if (r < c.round) missed++;
    }
    const total = done + missed;
    return {
      address: m.address,
      name: m.name,
      paid: done,
      missed,
      onTime: total === 0 ? 100 : Math.round((done / total) * 100),
    };
  });
}

export function saltFor(seed: string): `0x${string}` {
  return keccak256(toHex(seed));
}

export async function idFor(organiser: string, salt: `0x${string}`): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: CIRCLES,
    abi: circlesAbi,
    functionName: "circleId",
    args: [getAddress(organiser), salt],
  }) as Promise<`0x${string}`>;
}

const call = (fn: "create" | "join" | "start", args: readonly unknown[], gas: bigint) => ({
  to: CIRCLES,
  data: tag(encodeFunctionData({ abi: circlesAbi, functionName: fn, args: args as never })),
  gas: `0x${gas.toString(16)}`,
});

export function buildCreate(salt: `0x${string}`, amount: string, interval: number, name: string) {
  return call("create", [salt, parseUnits(amount, 18), BigInt(interval), name.slice(0, 60)], 300_000n);
}

export function buildJoin(id: `0x${string}`, name: string) {
  return call("join", [id, name.slice(0, 40)], 220_000n);
}

export function buildStart(id: `0x${string}`) {
  return call("start", [id], 150_000n);
}
