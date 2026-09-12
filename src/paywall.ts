import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config } from "./config.js";

export const NETWORK = "eip155:42220";
export const RECEIPT_PRICE = 0.01;

/**
 * Both are EIP-3009 tokens the Celo facilitator settles. The signing domain is
 * pinned per token, read off each contract's DOMAIN_SEPARATOR: a wrong version
 * signs something that verifies as nonsense instead of failing loudly.
 */
export const PAYMENT_ASSETS = [
  { symbol: "USDT", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6, name: "Tether USD", version: "1" },
  { symbol: "USDC", address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, name: "USDC", version: "2" },
] as const;

const option = (price: number, asset: (typeof PAYMENT_ASSETS)[number]): PaymentOption => ({
  scheme: "exact",
  network: NETWORK,
  payTo: config.agentAddress,
  price: {
    amount: Math.round(price * 10 ** asset.decimals).toString(),
    asset: asset.address,
    extra: { name: asset.name, version: asset.version },
  },
});

export const PAID_ROUTES = {
  "GET /v1/receipt/*": {
    price: RECEIPT_PRICE,
    description: "Check a payment really landed on Celo: status, confirmations, token transfers, and whether it paid who it should",
  },
};

export function paywall() {
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: async () => {
      const auth: Record<string, string> = config.x402ApiKey ? { "X-API-Key": config.x402ApiKey } : {};
      return { verify: auth, settle: auth, supported: auth };
    },
  });

  const settle = facilitator.settle.bind(facilitator);
  facilitator.settle = async (payload, requirements) => {
    const r = await settle(payload, requirements);
    if (!r.success) console.warn("[x402] settle failed", JSON.stringify(r));
    return r;
  };

  const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

  const routes: RoutesConfig = Object.fromEntries(
    Object.entries(PAID_ROUTES).map(([pattern, r]) => [
      pattern,
      {
        accepts: PAYMENT_ASSETS.map((a) => option(r.price, a)),
        description: r.description,
        mimeType: "application/json",
      },
    ]),
  );

  return paymentMiddleware(routes, server);
}
