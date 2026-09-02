import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { isAddress } from "viem";
import { MENTO_CURRENCIES, NGNM } from "./config.js";
import { canPayGasWith, feeCurrencyAllowlist } from "./chain.js";
import { balanceOf, buildTransfer, quote } from "./transfer.js";
import { nairaRate } from "./swap.js";
import {
  createCircle,
  duesFor,
  getCircle,
  join as joinCircle,
  listCircles,
  recordContribution,
  standings,
  start,
} from "./circle.js";

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

  const shape = (c: ReturnType<typeof getCircle>, viewer?: string) => ({
    id: c.id,
    name: c.name,
    amount: c.amount,
    interval: c.interval,
    organiser: c.organiser,
    started: Boolean(c.startedAt),
    members: c.members.map((m) => ({ address: m.address, name: m.name })),
    pot: (Number(c.amount) * Math.max(0, c.members.length - 1)).toString(),
    standings: standings(c),
    dues: viewer ? duesFor(c, viewer) : null,
  });

  app.post("/v1/circles", (req: Request, res: Response) => {
    try {
      const { name, amount, interval, organiser, organiserName } = req.body ?? {};
      const c = createCircle({ name, amount, interval: Number(interval), organiser, organiserName });
      res.json(shape(c, organiser));
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/circles/:id", (req: Request, res: Response) => {
    try {
      const viewer = (req.query.viewer as string) || undefined;
      res.json(shape(getCircle(req.params.id), viewer));
    } catch (e) {
      fail(res, e, 404);
    }
  });

  app.post("/v1/circles/:id/join", (req: Request, res: Response) => {
    try {
      const { address, name } = req.body ?? {};
      res.json(shape(joinCircle(req.params.id, address, name), address));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/v1/circles/:id/start", (req: Request, res: Response) => {
    try {
      const { by } = req.body ?? {};
      res.json(shape(start(req.params.id, by), by));
    } catch (e) {
      fail(res, e);
    }
  });

  // The transaction is the truth. This only indexes a transfer that already
  // happened, so a member cannot mark themselves paid without paying.
  app.post("/v1/circles/:id/paid", (req: Request, res: Response) => {
    try {
      const { from, txHash } = req.body ?? {};
      res.json(shape(recordContribution(req.params.id, from, txHash), from));
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/v1/circles/:id/dues/:address", (req: Request, res: Response) => {
    try {
      const c = getCircle(req.params.id);
      const dues = duesFor(c, req.params.address);
      res.json({
        ...dues,
        transaction: dues.owed && dues.recipient ? buildTransfer(dues.recipient, c.amount) : null,
      });
    } catch (e) {
      fail(res, e, 404);
    }
  });

  app.get("/v1/mine/:address", (req: Request, res: Response) => {
    try {
      if (!isAddress(req.params.address)) throw new Error("not a valid address");
      res.json(listCircles(req.params.address).map((c) => shape(c, req.params.address)));
    } catch (e) {
      fail(res, e);
    }
  });

  return app;
}
