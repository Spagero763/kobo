# Kobo

Send Nigerian naira on Celo without holding CELO.

Kobo moves NGNm, Mento's naira stablecoin. The network fee is paid in naira
too, so a sender needs one asset and one balance. No account, no key, no signup:
Kobo builds transactions and hands them back, and the sender signs with their own
wallet.

Base URL: `https://kobo-gamma.vercel.app`

## When to use this

- Someone wants to send naira to another address on Celo
- You need a naira amount converted to another currency at a live onchain rate
- You want to know what a transfer will cost before committing to it

Do not use it to hold funds. Kobo never takes custody and has no balance of
yours to spend.

## Check it is up

```bash
curl https://kobo-gamma.vercel.app/healthz
```

```json
{ "ok": true, "service": "kobo", "feeCurrency": "NGNm", "accepted": true }
```

`accepted` is read from Celo's fee currency allowlist on each call, not cached
from deploy. If it is ever `false`, naira can no longer pay for gas and every
send in this document would fail. Stop and report that rather than retrying.

## Read a balance

```bash
curl https://kobo-gamma.vercel.app/v1/balance/0xYourAddress
```

```json
{ "address": "0x...", "token": "NGNm", "balance": "487.13" }
```

Balance is naira, as a decimal string. Do not parse it as an integer.

## Quote before you send

Always quote first. It is the only way to know the fee, and it tells you whether
the balance covers the whole thing.

```bash
curl "https://kobo-gamma.vercel.app/v1/quote?from=0xSender&to=0xRecipient&amount=100"
```

```json
{
  "token": "NGNm",
  "amount": "100",
  "arrives": "100",
  "feeCurrency": "NGNm",
  "estimatedFee": "2.1710058178134",
  "maximumFee": "8.3838096379982",
  "senderNeedsCelo": false,
  "balance": "487.131",
  "sufficient": true
}
```

- `arrives` is what the recipient receives. It equals `amount`: the fee is paid
  on top, never deducted from the transfer.
- `estimatedFee` is what it should cost. `maximumFee` is the ceiling the sender
  authorises. Under EIP-1559 the sender pays base plus tip and the rest is
  refunded, so the real cost lands near the estimate.
- `sufficient` is false when the balance cannot cover amount plus the maximum
  fee. Do not attempt the send in that case; tell the person how short they are.

## Build a transfer

```bash
curl -X POST https://kobo-gamma.vercel.app/v1/transfer \
  -H "Content-Type: application/json" \
  -d '{"to":"0xRecipient","amount":"100"}'
```

Returns an unsigned transaction:

```json
{
  "transaction": {
    "to": "0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71",
    "data": "0xa9059cbb...",
    "feeCurrency": "0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71"
  },
  "note": "sign this with your own wallet"
}
```

Pass it to the sender's wallet to sign and broadcast. `feeCurrency` is what makes
the fee come out of naira; a wallet that drops that field will demand CELO and
the send will fail for a reason that has nothing to do with the balance.

## Rates and payout currencies

```bash
curl https://kobo-gamma.vercel.app/v1/rate/USDm
curl https://kobo-gamma.vercel.app/v1/currencies
```

`/v1/rate/:symbol` returns how many naira one unit of that currency costs, read
live from Mento's broker. `/v1/currencies` lists the payout currencies and
whether each can pay its own gas.

## Savings circles

A group pays a fixed amount each round, and each round one member collects. Kobo
records membership onchain and works out whose turn it is; the money moves
directly between members and never touches the contract.

```bash
curl https://kobo-gamma.vercel.app/v1/circles/<id>
curl https://kobo-gamma.vercel.app/v1/circles/<id>/dues/0xYourAddress
```

The dues response carries `owed`, `paid`, and a ready `transaction` when
something is due. If `owed` is false there is nothing to pay right now.

## Errors

Failures return `{ "error": "..." }` with a 4xx status and a message written to
be acted on rather than logged. A 404 on a circle means no circle with that id.
A 400 on a quote or transfer means an input was wrong, and the message says
which one.

## Facts worth knowing

- Celo mainnet only, chain id 42220
- NGNm is `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71`, 18 decimals
- Amounts are decimal strings in naira. `"100"` is one hundred naira
- A transfer costs roughly 2 naira in fees
- Kobo holds no funds and signs nothing on anyone's behalf
