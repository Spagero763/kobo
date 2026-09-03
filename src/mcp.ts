import { isAddress } from "viem";
import { MENTO_CURRENCIES, NGNM } from "./config.js";
import { canPayGasWith, feeCurrencyAllowlist } from "./chain.js";
import { balanceOf, buildTransfer, quote } from "./transfer.js";
import { nairaRate } from "./swap.js";
import { contributions, getCircle, standings } from "./circle.js";
import { buildCrossSend, crossQuote } from "./crosspay.js";

const PROTOCOL_VERSION = "2025-06-18";

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json) => Promise<unknown>;
}

const address = (v: unknown, field: string): `0x${string}` => {
  if (typeof v !== "string" || !isAddress(v)) throw new Error(`${field} must be a Celo address`);
  return v;
};

const amount = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("amount must be a positive number of naira");
  return String(v);
};

const tools: Tool[] = [
  {
    name: "kobo_health",
    description:
      "Check Kobo is up and that naira can still pay for gas. Call this first if a send fails unexpectedly.",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({
      ok: await canPayGasWith(NGNM),
      service: "kobo",
      feeCurrency: "NGNm",
    }),
  },
  {
    name: "kobo_balance",
    description: "Read an address's naira (NGNm) balance on Celo mainnet.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Celo address, 0x..." } },
      required: ["address"],
    },
    run: async (a) => {
      const who = address(a.address, "address");
      return { address: who, token: "NGNm", balance: (Number(await balanceOf(who)) / 1e18).toFixed(2) };
    },
  },
  {
    name: "kobo_quote",
    description:
      "What a naira transfer will cost before sending. Returns the fee, what arrives, and whether the balance covers it. Always call this before kobo_build_transfer.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "sender address" },
        to: { type: "string", description: "recipient address" },
        amount: { type: "string", description: "naira, e.g. \"100\"" },
      },
      required: ["from", "to", "amount"],
    },
    run: async (a) => quote(address(a.from, "from"), address(a.to, "to"), amount(a.amount)),
  },
  {
    name: "kobo_build_transfer",
    description:
      "Build an unsigned naira transfer for the sender's own wallet to sign. Kobo never signs or holds funds. The feeCurrency field is what makes the fee come out of naira instead of CELO, so do not drop it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "recipient address" },
        amount: { type: "string", description: "naira, e.g. \"100\"" },
      },
      required: ["to", "amount"],
    },
    run: async (a) => ({
      transaction: buildTransfer(address(a.to, "to"), amount(a.amount)),
      note: "sign this with the sender's own wallet",
    }),
  },
  {
    name: "kobo_rate",
    description:
      "How many naira one unit of another Mento currency costs, read live from the broker. Symbols: USDm, EURm, GHSm, KESm, ZARm, XOFm, GBPm.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. USDm" } },
      required: ["symbol"],
    },
    run: async (a) => {
      const wanted = String(a.symbol ?? "");
      const entry = Object.entries(MENTO_CURRENCIES).find(
        ([s]) => s.toLowerCase() === wanted.toLowerCase(),
      );
      if (!entry) throw new Error(`unknown currency ${wanted}`);
      const rate = await nairaRate(entry[1] as `0x${string}`);
      if (rate === null) throw new Error(`no Mento pool between ${entry[0]} and NGNm`);
      return { symbol: entry[0], naira: Number(rate).toFixed(2) };
    },
  },
  {
    name: "kobo_currencies",
    description: "Payout currencies reachable from naira, and whether each can pay its own gas.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const allow = await feeCurrencyAllowlist();
      return {
        naira: { symbol: "NGNm", address: NGNM, canPayGas: allow.has(NGNM.toLowerCase()) },
        payouts: Object.entries(MENTO_CURRENCIES).map(([symbol, addr]) => ({
          symbol,
          address: addr,
          canPayGas: allow.has(addr.toLowerCase()),
        })),
      };
    },
  },
  {
    name: "kobo_quote_cross",
    description:
      "What it costs to send naira and have the recipient paid in another currency. Returns the fee as a share of the amount, because the fee is fixed rather than proportional and is poor value on small sends. Read the advice field if present.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "destination currency, e.g. KESm" },
        amount: { type: "string", description: "naira to send" },
        from: { type: "string", description: "sender address, optional, adds a balance check" },
      },
      required: ["to", "amount"],
    },
    run: async (a) =>
      crossQuote(
        String(a.to ?? ""),
        amount(a.amount),
        a.from ? address(a.from, "from") : undefined,
      ),
  },
  {
    name: "kobo_build_cross_send",
    description:
      "Build the two transactions that send naira and deliver another currency: an approval, then the send. Both are signed by the sender's own wallet, in that order. Quote first.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "destination currency, e.g. KESm" },
        amount: { type: "string", description: "naira to send" },
        recipient: { type: "string", description: "who receives the other currency" },
      },
      required: ["to", "amount", "recipient"],
    },
    run: async (a) =>
      buildCrossSend(String(a.to ?? ""), amount(a.amount), address(a.recipient, "recipient")),
  },
  {
    name: "kobo_circle",
    description: "Read a savings circle: members, amount per round, whose turn it is, and standings.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "circle id, 0x..." } },
      required: ["id"],
    },
    run: async (a) => {
      const c = await getCircle(String(a.id ?? ""));
      const paid = await contributions(c);
      return { ...c, standings: standings(c, paid) };
    },
  },
  {
    name: "kobo_dues",
    description:
      "What a member owes in a circle right now, with a ready transaction when something is due.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "circle id" },
        address: { type: "string", description: "member address" },
      },
      required: ["id", "address"],
    },
    run: async (a) => {
      const who = address(a.address, "address");
      const c = await getCircle(String(a.id ?? ""));
      const paid = await contributions(c);
      const isRecipient = c.recipient?.toLowerCase() === who.toLowerCase();
      const alreadyPaid = paid.some(
        (p) => p.round === c.round && p.from.toLowerCase() === who.toLowerCase(),
      );
      const inCircle = c.members.some((m) => m.address.toLowerCase() === who.toLowerCase());
      const owed = c.started && inCircle && !isRecipient && !alreadyPaid;
      return {
        round: c.round,
        recipient: c.recipient,
        amount: c.amount,
        owed,
        paid: alreadyPaid,
        collecting: isRecipient,
        transaction: owed && c.recipient ? buildTransfer(c.recipient, c.amount) : null,
      };
    },
  },
];

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * Handles one JSON-RPC message. Returns null for notifications, which take no
 * response, so the caller answers 202 rather than sending an empty body.
 */
export async function handleMcp(msg: Json): Promise<Json | null> {
  const { method, id, params } = msg as { method?: string; id?: unknown; params?: Json };

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "kobo", version: "0.1.0" },
        instructions:
          "Kobo sends Nigerian naira (NGNm) on Celo with the fee paid in naira, so a sender never needs CELO. Quote before building a transfer. Kobo holds no funds and signs nothing.",
      });

    case "notifications/initialized":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case "tools/call": {
      const name = params?.name as string;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return err(id, -32602, `unknown tool: ${name}`);
      try {
        const result = await tool.run((params?.arguments as Json) ?? {});
        return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        // Tool failures are results, not protocol errors: the model needs to
        // read the message and decide what to do rather than see a dead call.
        return ok(id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : "the call failed" }],
          isError: true,
        });
      }
    }

    default:
      return err(id, -32601, `unknown method: ${method}`);
  }
}
