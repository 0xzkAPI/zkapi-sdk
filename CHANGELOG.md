# Changelog

## 0.2.0 — 2026-10-04

- Added independent Robinhood Chain Mainnet support through `@zkapi/robinhood-sdk/mainnet`, with a pinned Mainnet deployment helper, public artifact hashes and existing recovery identity.
- Kept the root package entry point on Testnet and retained the original `ZkPay*` and `ZkApi*` names.
- **Configuration change:** callers must provide `rpcUrl` in both helpers and direct client configurations. Removed the bundled `PUBLIC_RPC_URL` constant. `switchToTestnet` / `switchToMainnet` now require a caller URL; wallet network registration and wallet-free receipt reads use it. There is no RPC fallback through the indexer API.
- Preserved Mainnet incremental synchronization, session invalidation, confirmation checkpoint floor, same-request retry and hidden/offline polling behavior.
- Added offline Mainnet/transport regression tests, independent proof-file download destinations, dual-entry package consumer checks and browser examples.
- Mainnet integration completed live Deposit/recovery/Send/Max acceptance separately. Standalone checks remain offline; native ETH only, no npm publication or independent audit.

## 0.1.0 — 2026-10-03

- Extracted the existing Robinhood Chain Testnet SDK into a standalone GPL-3.0-only source repository.
- Added `ZkApiClient` and related aliases without changing protocol, signing, key-derivation, note, or relay identities.
- Added a pinned testnet deployment helper with explicit service URLs and recovery origin.
- Added ESM and declaration builds, browser examples, integration and security guides, package consumer checks, and an offline CI template.
- Native testnet ETH only. No npm publication, Mainnet support, USDG support, or independent audit is claimed.
