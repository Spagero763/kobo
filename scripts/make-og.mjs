// Builds the social card. X and WhatsApp will not render SVG, so this rasterises
// to PNG at the 1200x630 both expect.
//   node scripts/make-og.mjs

import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fbfaf7"/>
      <stop offset="1" stop-color="#f1efe9"/>
    </linearGradient>
    <linearGradient id="green" x1="96" y1="300" x2="700" y2="300" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0f6b3c"/>
      <stop offset="1" stop-color="#17915a"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="6" fill="url(#green)"/>

  <g opacity="0.05">
    <circle cx="1035" cy="150" r="230" fill="#127a45"/>
  </g>

  <text x="96" y="132" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#127a45" letter-spacing="1">KOBO</text>

  <text x="96" y="268" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="76" font-weight="700" fill="#14140f" letter-spacing="-2.5">Send naira onchain</text>
  <text x="96" y="356" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="76" font-weight="700" fill="url(#green)" letter-spacing="-2.5">without holding CELO</text>

  <text x="96" y="428" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="30" fill="#5f5c53">The network fee comes out of the naira too. One asset, one balance.</text>

  <g transform="translate(96,486)">
    <rect x="0" y="0" width="196" height="52" rx="26" fill="#ffffff" stroke="#e2ded6"/>
    <text x="30" y="34" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="22" fill="#4a473f">Celo mainnet</text>
    <rect x="212" y="0" width="150" height="52" rx="26" fill="#ffffff" stroke="#e2ded6"/>
    <text x="242" y="34" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="22" fill="#4a473f">MiniPay</text>
    <rect x="378" y="0" width="212" height="52" rx="26" fill="#ffffff" stroke="#e2ded6"/>
    <text x="408" y="34" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="22" fill="#4a473f">NGNm + cNGN</text>
  </g>

  <text x="1104" y="300" text-anchor="end" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="300" font-weight="700" fill="#127a45" opacity="0.13">₦</text>

  <text x="96" y="586" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="24" fill="#8d8a80">kobo-gamma.vercel.app</text>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
writeFileSync(new URL("../public/og.png", import.meta.url), png);
console.log(`public/og.png  ${(png.length / 1024).toFixed(1)} KB`);
