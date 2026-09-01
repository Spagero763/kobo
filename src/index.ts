import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { isAddress } from "viem";
import { config, NGNM, MENTO_CURRENCIES } from "./config.js";
import { canPayGasWith, feeCurrencyAllowlist } from "./chain.js";
import { balanceOf, buildTransfer, quote } from "./transfer.js";

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

/**
 * Returns the transaction for the sender's wallet to sign. Kobo never takes
 * custody, so a user's transfer is signed by the user and counts as theirs.
 */
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

app.listen(config.port, () => {
  console.log(`kobo on :${config.port}`);
  console.log(`wallet ${config.agentAddress}`);
  console.log(`tag    ${config.attributionTag || "(not set)"}`);
});
