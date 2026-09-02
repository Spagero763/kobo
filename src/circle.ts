import { randomBytes } from "node:crypto";
import { isAddress } from "viem";

/**
 * A rotating savings circle, the onchain shape of ajo.
 *
 * Kobo never holds the money. It records who owes what to whom this round, and
 * each member pays that round's recipient directly. That keeps every
 * contribution a transfer between two people, which is both the honest design
 * and the only one where the money is never sitting somewhere it can be lost.
 */

export interface Member {
  address: `0x${string}`;
  name: string;
  joinedAt: number;
}

export interface Contribution {
  from: `0x${string}`;
  to: `0x${string}`;
  round: number;
  txHash: string;
  at: number;
}

export interface Circle {
  id: string;
  name: string;
  /** Contribution per member per round, in whole naira. */
  amount: string;
  /** Seconds between rounds. */
  interval: number;
  organiser: `0x${string}`;
  members: Member[];
  /** Payout order, fixed when the circle starts so nobody can be reshuffled. */
  order: `0x${string}`[];
  startedAt: number | null;
  contributions: Contribution[];
  createdAt: number;
}

const circles = new Map<string, Circle>();

const id = () => randomBytes(6).toString("hex");
const now = () => Math.floor(Date.now() / 1000);

export function createCircle(opts: {
  name: string;
  amount: string;
  interval: number;
  organiser: string;
  organiserName: string;
}): Circle {
  if (!isAddress(opts.organiser)) throw new Error("organiser is not a valid address");
  if (!(Number(opts.amount) > 0)) throw new Error("amount must be greater than zero");
  if (!Number.isFinite(opts.interval) || opts.interval < 60) throw new Error("interval must be at least 60 seconds");
  if (!opts.name?.trim()) throw new Error("the circle needs a name");

  const circle: Circle = {
    id: id(),
    name: opts.name.trim().slice(0, 60),
    amount: opts.amount,
    interval: opts.interval,
    organiser: opts.organiser,
    members: [{ address: opts.organiser, name: opts.organiserName.trim().slice(0, 40) || "Organiser", joinedAt: now() }],
    order: [],
    startedAt: null,
    contributions: [],
    createdAt: now(),
  };
  circles.set(circle.id, circle);
  return circle;
}

export function getCircle(circleId: string): Circle {
  const c = circles.get(circleId);
  if (!c) throw new Error("no circle with that code");
  return c;
}

export function join(circleId: string, address: string, name: string): Circle {
  const c = getCircle(circleId);
  if (!isAddress(address)) throw new Error("not a valid address");
  if (c.startedAt) throw new Error("this circle has already started");
  if (c.members.length >= 20) throw new Error("this circle is full");
  if (c.members.some((m) => m.address.toLowerCase() === address.toLowerCase())) {
    throw new Error("you are already in this circle");
  }
  c.members.push({ address, name: name.trim().slice(0, 40) || "Member", joinedAt: now() });
  return c;
}

/**
 * Fixes the payout order and starts the clock. The order is shuffled once and
 * then frozen, so no one can be pushed down the queue after the fact.
 */
export function start(circleId: string, by: string): Circle {
  const c = getCircle(circleId);
  if (c.organiser.toLowerCase() !== by.toLowerCase()) throw new Error("only the organiser can start the circle");
  if (c.startedAt) throw new Error("already started");
  if (c.members.length < 2) throw new Error("a circle needs at least two members");

  const shuffled = c.members.map((m) => m.address);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  c.order = shuffled;
  c.startedAt = now();
  return c;
}

export function currentRound(c: Circle): number {
  if (!c.startedAt) return 0;
  const elapsed = now() - c.startedAt;
  return Math.min(Math.floor(elapsed / c.interval), c.order.length - 1);
}

export function recipientFor(c: Circle, round: number): `0x${string}` | null {
  return c.order[round] ?? null;
}

export interface Dues {
  round: number;
  recipient: `0x${string}` | null;
  recipientName: string | null;
  amount: string;
  owed: boolean;
  paid: boolean;
  roundsTotal: number;
  endsAt: number | null;
}

/** What this member owes right now, and to whom. */
export function duesFor(c: Circle, address: string): Dues {
  const round = currentRound(c);
  const recipient = recipientFor(c, round);
  const isRecipient = recipient?.toLowerCase() === address.toLowerCase();
  const inCircle = c.members.some((m) => m.address.toLowerCase() === address.toLowerCase());
  const paid = c.contributions.some(
    (x) => x.round === round && x.from.toLowerCase() === address.toLowerCase(),
  );

  return {
    round,
    recipient,
    recipientName: recipient ? nameOf(c, recipient) : null,
    amount: c.amount,
    // The person collecting this round does not pay into their own turn.
    owed: Boolean(c.startedAt) && inCircle && !isRecipient && !paid,
    paid,
    roundsTotal: c.order.length,
    endsAt: c.startedAt ? c.startedAt + (round + 1) * c.interval : null,
  };
}

export function nameOf(c: Circle, address: string): string {
  return c.members.find((m) => m.address.toLowerCase() === address.toLowerCase())?.name ?? "Member";
}

/**
 * Records a contribution against a transaction that already happened. The hash
 * is what makes it true; this record is only an index over the chain.
 */
export function recordContribution(circleId: string, from: string, txHash: string): Circle {
  const c = getCircle(circleId);
  if (!isAddress(from)) throw new Error("not a valid address");
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error("not a valid transaction hash");
  if (c.contributions.some((x) => x.txHash.toLowerCase() === txHash.toLowerCase())) return c;

  const round = currentRound(c);
  const to = recipientFor(c, round);
  if (!to) throw new Error("this circle has finished");

  c.contributions.push({ from, to, round, txHash, at: now() });
  return c;
}

export interface Standing {
  address: `0x${string}`;
  name: string;
  paid: number;
  missed: number;
  onTime: number;
}

/** Who has actually been paying. The reason to behave, and to come back. */
export function standings(c: Circle): Standing[] {
  const round = currentRound(c);
  return c.members.map((m) => {
    let paid = 0;
    let missed = 0;
    for (let r = 0; r <= round; r++) {
      if (recipientFor(c, r)?.toLowerCase() === m.address.toLowerCase()) continue;
      const did = c.contributions.some(
        (x) => x.round === r && x.from.toLowerCase() === m.address.toLowerCase(),
      );
      if (did) paid++;
      else if (r < round) missed++;
    }
    const total = paid + missed;
    return {
      address: m.address,
      name: m.name,
      paid,
      missed,
      onTime: total === 0 ? 100 : Math.round((paid / total) * 100),
    };
  });
}

export function listCircles(address: string): Circle[] {
  return [...circles.values()].filter((c) =>
    c.members.some((m) => m.address.toLowerCase() === address.toLowerCase()),
  );
}
