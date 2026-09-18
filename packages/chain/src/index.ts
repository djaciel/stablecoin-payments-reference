// The chain package: EVM access for the whole workspace. Address derivation lives here
// because two holders need the same rule — the signer for the company seed, the api's
// demo scaffolding for the partner seed. The RPC clients and the stablecoin contract
// join later, when something actually talks to the network.
export { TREASURY_ADDRESS_INDEX, deriveAccount } from './derive'
