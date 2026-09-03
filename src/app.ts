import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { isAddress } from "viem";
import { MENTO_CURRENCIES, NGNM } from "./config.js";
import { canPayGasWith, feeCurrencyAllowlist } from "./chain.js";
import { balanceOf, buildTransfer, cost, quote } from "./transfer.js";
import { nairaRate } from "./swap.js";
import {
  buildCreate,
  buildJoin,
  buildStart,
  contributions,
  getCircle,
  idFor,
  saltFor,
  standings,
} from "./circle.js";
import { handleMcp } from "./mcp.js";
import { buildCrossSend, crossQuote } from "./crosspay.js";
import { balanceOfToken, fromUnits, tokenBySymbol, withGasFlags } from "./tokens.js";
import { buildNairaTransfer, quoteNaira } from "./naira.js";
import { buildLink, status as personhoodStatus } from "./personhood.js";
import { toString } from "qrcode";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(process.cwd(), "public"), { index: "index.html" }));

  const fail = (res: Response, e: unknown, code = 400) =>
    res.status(code).json({ error: e instanceof Error ? e.message : "request failed" });

  app.get("/healthz", async (_req: Request, res: Response) => {
    try {
      const gasOk = await canPayGasWith(NGNM);
      res.status(gasOk ? 200 : 503).json({ ok: gasOk, service: "kobo", feeCurrency: "NGNm", accepted: gasOk });
    } catch (e) {
      fail(res, e, 503);
    }
  });

  app.get("/v1/balance/:address", async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      if (!isAddress(address)) throw new Error("not a valid address");
      const raw = await balanceOf(address);
      res.json({ address, token: "NGNm", balance: (Number(raw) / 1e18).toFixed(2) });
    } catch (e) {
      fail(res, e);
    }
  });

  // Deliberately needs no address. A reviewer and a first-time visitor should
  // both be able to see what a transfer costs without connecting anything.
  app.get("/v1/cost", async (req: Request, res: Response) => {
    try {
      const amount = (req.query.amount as string) ?? "5000";
      if (!(Number(amount) > 0)) throw new Error("amount must be greater than zero");
      res.json(await cost(amount));
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/quote", async (req: Request, res: Response) => {
    try {
      const { from, to, amount } = req.query as Record<string, string>;
      if (!from || !isAddress(from)) throw new Error("from must be a valid address");
      if (!to) throw new Error("to is required");
      if (!amount) throw new Error("amount is required");
      res.json(await quote(from, to, amount));
    } catch (e) {
      fail(res, e);
    }
  });

  // Returns the transaction for the sender's own wallet to sign. Kobo never
  // takes custody, so the transfer belongs to the person who signed it.
  app.post("/v1/transfer", async (req: Request, res: Response) => {
    try {
      const { to, amount } = req.body as { to?: string; amount?: string };
      if (!to || !isAddress(to)) throw new Error("to must be a valid address");
      if (!amount) throw new Error("amount is required");
      res.json({ transaction: buildTransfer(to, amount), note: "sign this with your own wallet" });
    } catch (e) {
      fail(res, e);
    }
  });

  // Both naira on Celo. They are different tokens from different issuers, so
  // the symbol is required rather than guessed.

  app.get("/v1/naira", async (_req: Request, res: Response) => {
    try {
      const tokens = await withGasFlags();
      res.json({
        tokens: tokens.map((t) => ({
          symbol: t.symbol,
          label: t.label,
          address: t.address,
          decimals: t.decimals,
          canPayOwnGas: t.payGas,
        })),
        feeAlwaysPaidIn: "NGNm",
        note: "cNGN cannot pay for its own gas on Celo, so its fee is taken in NGNm. Either way the sender never needs CELO.",
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/naira/:symbol/balance/:address", async (req: Request, res: Response) => {
    try {
      const token = tokenBySymbol(req.params.symbol);
      if (!token) throw new Error(`unknown token ${req.params.symbol}, expected NGNm or cNGN`);
      const address = req.params.address;
      if (!isAddress(address)) throw new Error("not a valid address");
      res.json({
        address,
        token: token.symbol,
        label: token.label,
        balance: fromUnits(token, await balanceOfToken(token, address)),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/naira/:symbol/quote", async (req: Request, res: Response) => {
    try {
      const token = tokenBySymbol(req.params.symbol);
      if (!token) throw new Error(`unknown token ${req.params.symbol}, expected NGNm or cNGN`);
      const { from, to, amount } = req.query as Record<string, string>;
      if (!from || !isAddress(from)) throw new Error("from must be a valid address");
      if (!to || !isAddress(to)) throw new Error("to must be a valid address");
      if (!amount) throw new Error("amount is required");
      res.json(await quoteNaira(token, from, to, amount));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/v1/naira/:symbol/build", async (req: Request, res: Response) => {
    try {
      const token = tokenBySymbol(req.params.symbol);
      if (!token) throw new Error(`unknown token ${req.params.symbol}, expected NGNm or cNGN`);
      const { to, amount } = req.body ?? {};
      if (!to || !isAddress(to)) throw new Error("to must be a valid address");
      if (!amount) throw new Error("amount is required");
      res.json({
        transaction: buildNairaTransfer(token, to, String(amount)),
        note: "sign this with your own wallet. the fee comes out of NGNm.",
      });
    } catch (e) {
      fail(res, e);
    }
  });

  // Proof of personhood. A circle needs to tell one member from the same member
  // twice, and an address cannot answer that.

  app.get("/v1/personhood/:address", async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      if (!isAddress(address)) throw new Error("not a valid address");
      res.json(await personhoodStatus(address));
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/personhood/:address/link", async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      if (!isAddress(address)) throw new Error("not a valid address");
      const { link, sessionId } = buildLink(address);
      // The QR is rendered here so the page needs no QR library of its own.
      const qr = await toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "L" });
      res.json({ link, sessionId, qr });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/currencies", async (_req: Request, res: Response) => {
    try {
      const allow = await feeCurrencyAllowlist();
      res.json({
        naira: { symbol: "NGNm", address: NGNM, canPayGas: allow.has(NGNM.toLowerCase()) },
        payouts: Object.entries(MENTO_CURRENCIES).map(([symbol, address]) => ({
          symbol,
          address,
          canPayGas: allow.has(address.toLowerCase()),
        })),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/rate/:symbol", async (req: Request, res: Response) => {
    try {
      const symbol = req.params.symbol;
      const entry = Object.entries(MENTO_CURRENCIES).find(([s]) => s.toLowerCase() === symbol.toLowerCase());
      if (!entry) throw new Error(`unknown currency ${symbol}`);
      const rate = await nairaRate(entry[1] as `0x${string}`);
      if (rate === null) throw new Error(`no Mento pool between ${entry[0]} and NGNm`);
      res.json({ symbol: entry[0], naira: Number(rate).toFixed(2) });
    } catch (e) {
      fail(res, e);
    }
  });

  // Circles live in the registry contract, so state survives restarts and each
  // member joins with their own signature. These endpoints read the chain and
  // hand back transactions to sign; the server never acts on anyone's behalf.

  app.get("/v1/circles/:id", async (req: Request, res: Response) => {
    try {
      const c = await getCircle(req.params.id);
      const paid = await contributions(c);
      res.json({ ...c, standings: standings(c, paid), contributions: paid });
    } catch (e) {
      fail(res, e, 404);
    }
  });

  app.post("/v1/circles/build", async (req: Request, res: Response) => {
    try {
      const { organiser, name, amount, interval } = req.body ?? {};
      if (!organiser || !isAddress(organiser)) throw new Error("organiser must be a valid address");
      if (!name?.trim()) throw new Error("the circle needs a name");
      if (!(Number(amount) > 0)) throw new Error("amount must be greater than zero");
      const seconds = Number(interval);
      if (!Number.isFinite(seconds) || seconds < 60) throw new Error("interval must be at least 60 seconds");

      const salt = saltFor(`${organiser}:${name}:${Date.now()}`);
      const id = await idFor(organiser, salt);
      res.json({ id, transaction: buildCreate(salt, String(amount), seconds, name) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/v1/circles/:id/build/join", async (req: Request, res: Response) => {
    try {
      const { name } = req.body ?? {};
      const c = await getCircle(req.params.id);
      if (c.started) throw new Error("this circle has already started");
      res.json({ transaction: buildJoin(c.id, String(name ?? "Member")) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/v1/circles/:id/build/start", async (req: Request, res: Response) => {
    try {
      const c = await getCircle(req.params.id);
      if (c.started) throw new Error("this circle has already started");
      if (c.members.length < 2) throw new Error("a circle needs at least two members");
      res.json({ transaction: buildStart(c.id) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/circles/:id/dues/:address", async (req: Request, res: Response) => {
    try {
      const address = req.params.address;
      if (!isAddress(address)) throw new Error("not a valid address");
      const c = await getCircle(req.params.id);
      const paid = await contributions(c);

      const isRecipient = c.recipient?.toLowerCase() === address.toLowerCase();
      const inCircle = c.members.some((m) => m.address.toLowerCase() === address.toLowerCase());
      const alreadyPaid = paid.some(
        (p) => p.round === c.round && p.from.toLowerCase() === address.toLowerCase(),
      );
      const owed = c.started && inCircle && !isRecipient && !alreadyPaid;

      res.json({
        round: c.round,
        roundsTotal: c.roundsTotal,
        recipient: c.recipient,
        recipientName: c.members[c.round]?.name ?? null,
        amount: c.amount,
        owed,
        paid: alreadyPaid,
        collecting: isRecipient,
        endsAt: c.started ? c.startedAt + (c.round + 1) * c.interval : null,
        transaction: owed && c.recipient ? buildTransfer(c.recipient, c.amount) : null,
      });
    } catch (e) {
      fail(res, e, 404);
    }
  });

  // Naira in, another currency out. The sender holds only naira and never
  // touches the destination asset or a gas token.

  app.get("/v1/quote/cross", async (req: Request, res: Response) => {
    try {
      const { to, amount, from } = req.query as Record<string, string>;
      if (!to) throw new Error("to is required, e.g. to=KESm");
      if (!amount) throw new Error("amount is required, in naira");
      if (from && !isAddress(from)) throw new Error("from must be a valid address");
      res.json(await crossQuote(to, amount, from as `0x${string}` | undefined));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/v1/send-as/build", async (req: Request, res: Response) => {
    try {
      const { to, amount, recipient } = req.body ?? {};
      if (!to) throw new Error("to is required, e.g. \"KESm\"");
      if (!amount) throw new Error("amount is required, in naira");
      if (!recipient || !isAddress(recipient)) throw new Error("recipient must be a valid address");
      res.json(await buildCrossSend(String(to), String(amount), recipient));
    } catch (e) {
      fail(res, e);
    }
  });

  // MCP, so an agent can use Kobo as tools rather than by reading docs and
  // composing HTTP calls itself. Stateless: every message carries what it needs,
  // which is what serverless can actually honour.
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map(handleMcp))).filter(Boolean);
        return out.length ? res.json(out) : res.status(202).end();
      }
      const reply = await handleMcp(body ?? {});
      return reply ? res.json(reply) : res.status(202).end();
    } catch (e) {
      res.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: e instanceof Error ? e.message : "internal error" },
      });
    }
  });

  app.get("/mcp", (_req: Request, res: Response) =>
    res.status(405).json({ error: "MCP uses POST with a JSON-RPC body" }),
  );

  return app;
}
