# Kobo

Send naira onchain without holding CELO.

Kobo moves naira on Celo mainnet and pays the network fee in naira, so a sender
never has to acquire CELO, learn what gas is, or keep a second balance topped up.

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

## Two naira, both supported

There are two naira stablecoins on Celo, from two unrelated issuers, and they are
not interchangeable.

| | NGNm | cNGN |
| --- | --- | --- |
| Issuer | Mento | independent, SEC-regulated |
| Decimals | 18 | 6 |
| Pays its own gas | yes | no |

Only NGNm is on Celo's fee currency allowlist, which is governance controlled and
readable onchain via `getCurrencies()` on the FeeCurrencyDirectory. So a cNGN
transfer cannot pay for itself.

Kobo sends both. The fee comes out of whatever allowlisted token the sender
already holds, naira first, then USDm, USD₮ or USDC. A cNGN holder with a little
NGNm or a few cents of dollars never needs CELO. The quote names the fee token
before anything is signed rather than failing at the wallet.

## Dollars too

Most MiniPay balances are dollars, and a lot of money sent home is sent in them.
USD₮, USDC and USDm go through the same send flow, and each pays its own fee:
USDm directly, USD₮ and USDC through their fee currency adapters. A USD₮ transfer
costs about a fifth of a cent.

## Check a payment

Fake transfer alerts are an old trick. A screenshot, an SMS, a hash that looks
right. `GET /v1/receipt/:hash` reads the chain and answers whether a payment
really landed, how many confirmations it has, and whether it paid the right
address the right amount. Only the real token contracts are counted, so a
look-alike token named cNGN moves nothing.

It costs $0.01, paid over x402 in USD₮ or USDC. The payer signs an EIP-3009
authorisation and the Celo facilitator settles it, so neither side needs gas. A
malformed hash is a 400 and is never charged. Prices are published at
`/v1/paid`, and the web app has the same check under the Check tab.

The six against eighteen decimals is a factor of a trillion, and a wrong constant
does not throw, it sends the wrong amount. `npm run verify:tokens` reads the
decimals off each contract and refuses to pass if the registry disagrees.

## Addresses

Celo mainnet, chain 42220.

| | |
| --- | --- |
| NGNm | `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71` |
| cNGN | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` |
| Mento broker | `0x777A8255cA72412f0d706dc03C9D1987306B4CaD` |
| FeeCurrencyDirectory | `0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276` |
| Circles | `0xce0b075d9b2ba71f4c8097e3a43e7d1240505173` |
| Payout | `0xdfcf531070a11c94464768547ff239e6bacf4b00` |
| Personhood | `0x2101de8279476359b4d33c3a5131634b2228c4aa` |
| USD₮ / adapter | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` / `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72` |
| USDC / adapter | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` / `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B` |
| USDm | `0x765DE816845861e75A25fCA122bb6898B8B1282a` |

Payout was redeployed to add the two-hop route through USDm. The first
deployment, `0xed75e88e1733ebe2bff0b5c0e7a315493e45536a`, is no longer used.

NGNm is 18 decimals and allowlisted directly, so it needs no fee currency
adapter. Tokens with other decimals, USDC and USD₮ among them, are allowlisted
through adapters instead and cannot be passed as `feeCurrency` by their own
address. The adapters report balances and gas prices in 18 decimals.

## Proving it

```bash
npm run prove:cngn -- <recipient> <amount>
npm run prove:send -- USDT <recipient> <amount>
```

Each sends a real transfer from the agent wallet and checks, at one block, that
the recipient got the exact amount and the sender's CELO balance did not move.

## Stack

Celo mainnet, NGNm, cNGN, USD₮, USDC and USDm, Mento for FX, CIP-64 fee
abstraction, x402 for the paid receipt check, Self for proof of personhood,
ERC-8021 attribution, TypeScript.

Proof of personhood guards the savings circles, where one person holding several
seats is the obvious abuse. A passport proof through Self binds one address to
one person, and the contract keeps only a nullifier.

## License

MIT
