# Kobo

Send naira onchain without holding CELO.

Kobo moves cNGN, Nigeria's regulated naira stablecoin, on Celo mainnet. Gas is
paid in the stablecoin itself, so a sender never has to acquire CELO, learn what
gas is, or keep a second balance topped up. One account per person, proven with
a passport rather than a phone number.

It works from four places: a web app, a REST API, an MCP server, and an
installable agent skill. A person sends naira from the web app. An agent sends
naira by calling a tool. Same rails underneath.

## Why

Sending money home is the most common reason a Nigerian touches crypto, and the
worst-served. The usual onchain version asks you to hold two assets, one of
which exists only to pay fees, and to understand why a transfer failed for
reasons unrelated to your balance. Agents have it worse: they cannot open an
account, pass a KYC form, or hold a card, so most payment rails are closed to
them entirely.

cNGN removes the currency problem. Fee abstraction removes the gas problem.
Kobo is what is left once both are gone.

## Status

Early. Building in the open.

## Stack

Celo mainnet, cNGN, CIP-64 fee abstraction, Self for proof of personhood,
ERC-8021 attribution, TypeScript.

## License

MIT
