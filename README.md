# Stablecoin Payments Reference

A demo app that shows how a stablecoin payment orchestration system works:

- It simulates two sides, a company and its partners. You play both: `/admin` is the company, `/partner` is a partner.
- It runs on a public blockchain testnet (Base Sepolia) with test money only. Never send real money to its addresses.
- You do not need a wallet: the app creates its own keys the first time it starts.

## What you need

Docker with Compose v2. No keys to paste and no settings to fill in.

## Start it

```sh
docker compose up
```

On the first start it:

- builds one image and downloads Postgres and Temporal (a few minutes; later starts are fast),
- creates the company seed in `.keys/company/` and a second seed that plays the partners' wallets in `.keys/partner/` (both stay on your disk, out of git),
- adds two partners, **Northwind Logistics** and **Bluefin Studio**, each with its own deposit address.

Then open `http://localhost:5173/admin` (the company's side) and `http://localhost:5173/partner` (what a partner sees).

If a port is already taken on your machine, copy `.env.example` to `.env` and change the port there.

## Fund the treasury

`/admin` opens on **Start**. Copy the address on the **Treasury** card and fund it from two faucets:

- **Testnet USDC**, the money the demo moves: the [Circle faucet](https://faucet.circle.com). Pick Base Sepolia.
- **Base Sepolia ETH**, which pays the gas: the [ZalalenA faucet](https://faucet.zalalena.com/base), no sign-in. One drop of about 0.001 ETH is enough.
- If it refuses you, the [Coinbase faucet](https://www.coinbase.com/developer-platform/products/faucet) also gives Base Sepolia ETH. It asks for a Coinbase sign-in.

You need both: without ETH nothing can be sent.

The **Treasury** card shows the money first; **Books** updates a few minutes later, once the block is final.

## Your first payout

1. On `/partner`, press **Fund partner wallet**, then **Send**. It moves 2 USDC and 0.0003 ETH from the treasury to the wallet the partners pay from, which your first deposit needs. The button stays off until the treasury holds 2 USDC and 0.0004 ETH.
2. On **Invoices to pay**, under **New invoice**, pick Northwind Logistics, type `0.10` and a description, and press **Create**.
3. On the invoice's card, press **Pay**, then **Pay** again in the dialog. The card now shows a **Payment status** and a **Reference** (`PAY-` and four digits).
4. Click the reference to open the payment's story: **Created**, **Reserved**, **Signed**, **Sent**, **Paid**, **Settled**. Paid waits a few minutes for the block to be final.
5. On the story, **The transfer on Base Sepolia** opens the real transaction, and **Its runs in Temporal** opens the workflow (`http://localhost:8080`, which keeps finished runs for 30 days).

## Your first deposit

1. On **Invoices to collect**, under **New invoice**, pick Northwind Logistics, type `0.05` and a description, and press **Create**.
2. On `/partner`, under **You are**, pick Northwind Logistics. In **What you owe**, press **Pay** on the invoice, then **Pay** in the dialog.
3. On **Transfers**, under **Money that arrived, newest first**, the deposit shows as DETECTED within seconds (seen, not yet in the books). Once its block is final it turns SETTLED and the invoice turns PAID.

The company knows this money is Northwind's because it arrived at the address only Northwind was given, not because of the amount or the sender.

## It checks itself

On **Reconciliation**, press **Run now**. The new run shows three cards:

- **Books**: Available + Reserved + Deposits.
- **Chain**: what the treasury and the partner addresses hold, read at one fixed block.
- **In flight**: money one side has moved and the other has not yet.

**Books and chain agree** means every difference is in flight. **Something is not explained** is what a person has to look at. Below the cards are the payments and deposits that need a look (**Show all** lists every one). The check also runs by itself every ten minutes.

## Break it

**Break it**, the last tab, has five cards: Double click, The race, Crash after signing, Node not responding and Revert a payment. **Run it** on a card causes that failure for real and leaves the evidence on the card. Most cost 0.01 USDC and take a few minutes; The race runs in a separate database and costs nothing. More in [`docs/experiments.md`](docs/experiments.md).

## Stop and reset

- `docker compose down` stops everything and keeps the database. The next `docker compose up` is where you left it.
- `docker compose down -v` also deletes the database: the books, invoices, payments and audit log. The seeds stay, so the treasury keeps its address and its money. The new watcher only looks back about 5.5 hours, so older funding is not recorded again: the books start at zero and Reconciliation reports the gap (correctly).
- Deleting `.keys/` gives you a new, empty treasury. Run `docker compose down -v` as well, or the database keeps the old treasury's nonces and payouts will not land.

## Where to look next

- [`GUIDE.md`](GUIDE.md): the map. For each topic, the files to open and how to see them run.
- [`docs/schema.md`](docs/schema.md): the tables and accounts, and how to read the books with `psql`.
- [`docs/states.md`](docs/states.md): the states of payments, deposits, invoices and reconciliation runs.
- [`docs/api.md`](docs/api.md): every endpoint.
- [`docs/experiments.md`](docs/experiments.md): the Break it cards and the terminal commands that match them.
- [`docs/integration-points.md`](docs/integration-points.md): where real compliance, custody and bank money plug in.

## License

MIT, see [LICENSE](LICENSE).
