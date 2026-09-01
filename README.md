# Kobo

Send naira onchain without holding CELO.

Kobo moves NGNm, Mento's naira stablecoin, on Celo mainnet. Gas is paid in the
naira itself, so a sender never has to acquire CELO, learn what gas is, or keep a
second balance topped up. One account per person, proven with a passport rather
than a phone number.

It works from four places: a web app, a REST API, an MCP server, and an
installable agent skill. A person sends naira from the web app. An agent sends
naira by calling a tool. Same rails underneath.

## Why

Sending money home is the most common reason a Nigerian touches crypto, and the
worst-served. The usual onchain version asks you to hold two assets, one of which
exists only to pay fees, and to understand why a transfer failed for reasons
unrelated to your balance. Agents have it worse: they cannot open an account,
pass a KYC form, or hold a card, so most payment rails are closed to them
entirely.

A naira stablecoin removes the currency problem. Fee abstraction removes the gas
problem. Kobo is what is left once both are gone.

## Naira in, anything out

NGNm sits on Mento's broker alongside USDm, GHSm, KESm, ZARm, XOFm and a dozen
others. So Kobo is not limited to moving naira between Nigerians. A sender holds
naira, and the recipient is paid in whatever their own country spends, with the
exchange settled onchain in the same transaction that moves the money.

The sender still never holds anything but naira. Not the fee asset, not the
destination currency.

## Why NGNm and not cNGN

Two different tokens have been called cNGN. Mento's naira, now branded NGNm, and
the SEC-regulated one issued by the Convexity consortium, which deployed to Celo
in August 2026.

Only one of them can pay for its own gas. Celo's fee currency allowlist is
governance controlled and readable onchain by calling `getCurrencies()` on the
FeeCurrencyDirectory. NGNm is on it. The regulated cNGN is not, so a sender
holding it would still need CELO, which is the entire problem Kobo exists to
remove.

If cNGN is added to the allowlist later, supporting it is a config change. The
allowlist is checked at startup rather than hardcoded, so the day it lands Kobo
can use it.

## Addresses

Celo mainnet, chain 42220.

| | |
| --- | --- |
| NGNm | `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71` |
| Mento broker | `0x777A8255cA72412f0d706dc03C9D1987306B4CaD` |
| FeeCurrencyDirectory | `0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276` |

NGNm is 18 decimals and allowlisted directly, so it needs no fee currency
adapter. Tokens with other decimals, USDC and USD₮ among them, are allowlisted
through adapters instead and cannot be passed as `feeCurrency` by their own
address.

## Status

Early. Building in the open.

## Stack

Celo mainnet, NGNm, Mento for FX, CIP-64 fee abstraction, Self for proof of
personhood, ERC-8021 attribution, TypeScript.

## License

MIT
