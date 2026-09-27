# Funding the treasury from testnet faucets

The treasury address is on the admin Start screen (<http://localhost:5173/admin>). Funding it is the only manual step in the repo. It needs two things:

| What | Why | Where |
|---|---|---|
| Testnet USDC | the money the demo moves | <https://faucet.circle.com>, network **Base Sepolia** |
| Base Sepolia ETH | pays the gas; without it nothing can be sent, however much USDC there is | any gas faucet below |

## Testnet USDC

- Circle's faucet gives the contract the repo checks every transfer against: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- A "USDC" from another contract is refused as a payment. That is the settlement rule working.
- Limit: 20 USDC every 2 hours, per address and per chain, no sign-in (checked 2026-09-21).

## Base Sepolia ETH for gas

If one refuses you, try the next:

- ZalalenA: <https://faucet.zalalena.com/base>, no sign-in, about 0.001 ETH per drop. That is enough for everything in the demo.
- Coinbase: <https://www.coinbase.com/developer-platform/products/faucet>, needs a Coinbase sign-in.
- Superchain: <https://console.optimism.io/faucet>
- QuickNode and Alchemy ask for an ETH balance on mainnet.

One drop is plenty: a USDC transfer costs about 0.0000002 ETH.

## Funding the partner wallet from the treasury

The partner wallet (the wallet partners pay you from) is funded with **Fund partner wallet** on `/partner`.

- It sends 2 USDC and 0.0003 ETH from the treasury, waits for both receipts, and posts one `demo:partner-funding` entry.
- The treasury needs at least 2 USDC (on chain and in the books) and 0.0004 ETH (the extra runs the two transactions). The partner wallet then pays hundreds of invoices on that gas.
- `GET /treasury` shows these under `partnerWallet.funding.requires`. Below them the button is off and the api answers 422 with how much is missing.

## Faucet rules drift

Faucets change limits, ask for sign-in, or want a mainnet balance. If a link is stale, search for "Base Sepolia faucet". The demo only cares that the USDC is the contract above.

## Checking the balance by hand

The Start screen reads both balances from the chain. To check outside the repo, open the treasury address on <https://sepolia.basescan.org>. The ledger figures stay at zero until the watcher posts the funding (a final block).
