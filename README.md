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

Kobo sends both, and takes the fee in NGNm either way. A cNGN holder therefore
needs a small NGNm float for fees, the way you keep coins for a bus fare, but
still never needs CELO. The quote says so before anything is signed rather than
failing at the wallet.

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
| Payout | `0xed75e88e1733ebe2bff0b5c0e7a315493e45536a` |

NGNm is 18 decimals and allowlisted directly, so it needs no fee currency
adapter. Tokens with other decimals, USDC and USD₮ among them, are allowlisted
through adapters instead and cannot be passed as `feeCurrency` by their own
address.

## Status

Early. Building in the open.

## Stack

Celo mainnet, NGNm and cNGN, Mento for FX, CIP-64 fee abstraction, ERC-8021
attribution, TypeScript.

Proof of personhood is not implemented. It is worth having for the savings
circles, where one person holding several seats is the obvious abuse, but it is
not built and this file will not claim otherwise until it is.

## License

MIT
