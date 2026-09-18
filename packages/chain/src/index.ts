// The chain package: EVM access for the whole workspace. Address derivation lives here
// because two holders need the same rule — the signer for the company seed, the api's
// demo scaffolding for the partner seed. The clients read the network, and the stablecoin
// contract brings the rule that decides whether a transfer happened.
//
// Plain TypeScript over viem: nothing here knows about NestJS, Postgres or the ledger,
// and nothing here holds a key.
export { TREASURY_ADDRESS_INDEX, deriveAccount } from './derive'
export {
  CHAIN,
  createChainClient,
  explorerAddressUrl,
  explorerTransactionUrl,
  readRpcUrl,
  rpcHost,
  type ChainClient,
} from './clients'
export { ERC20_ABI, USDC_ADDRESS, findSettlementLog, readUsdcBalance, type ExpectedTransfer } from './usdc'
