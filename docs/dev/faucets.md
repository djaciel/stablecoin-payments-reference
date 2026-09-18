# Funding the treasury from testnet faucets

The demo generates its own treasury address on first start and shows it on the admin Start
screen (<http://localhost:5173/admin>). Funding it from public faucets is the only manual
step in this repo: nothing else asks you to paste a key, connect a wallet or set a
variable.

The treasury needs **two different things**, and running out of either one fails in a
different way:

- **Base Sepolia ETH** — pays the gas. Without it nothing can be sent at all, however much
  USDC the address holds.
- **Testnet USDC** — the money the demo moves.

People usually get the second and forget the first, then read a confusing error about
insufficient funds on an address that visibly holds USDC. That is this.

## Testnet USDC

Circle's faucet: <https://faucet.circle.com>. Pick **Base Sepolia** as the network and
paste the treasury address from the Start screen.

The token it gives you is the contract this repo checks every transfer against,
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. If some other faucet hands you a different
"USDC", the settlement rule will correctly refuse to call the transfer a payment — that
refusal is the point of the rule, not a bug in the demo.

## Base Sepolia ETH for gas

Any of these works; they change their rules more often than Circle does, so try the next
one if the first refuses you:

- Coinbase Developer Platform faucet — <https://portal.cdp.coinbase.com/products/faucet>
  (Base Sepolia; sign-in required)
- Alchemy Base Sepolia faucet — <https://www.alchemy.com/faucets/base-sepolia>
- Superchain faucet — <https://console.optimism.io/faucet>

A single request is far more than the demo needs: a USDC transfer on Base Sepolia costs on
the order of 0.0000002 ETH, so a faucet's usual drop covers thousands of them.

## Faucet rules drift

Everything above was true when it was written and none of it is a promise. Faucets change
their limits, start asking for a signed-in account, or require a mainnet balance to prove
you are not a bot. If one of these links has gone stale, search for "Base Sepolia faucet"
and use what you find — the demo does not care where the funds came from, only that they
are the official USDC contract above.

## Checking the balance by hand

The Start screen reads both balances from the chain and prints the block it read them at.
To check it against something that is not this repo, open the treasury address on
<https://sepolia.basescan.org>: the ETH balance is on the account page, the USDC balance
under the token holdings.

The ledger figures next to them stay at zero until something posts the funding to the
books. That gap is deliberate, and closing it is what the watcher does.
