# Changelog

## 0.3.1 — 2026-10-04

- Keep wallet sessions active when a provider repeats the same account or Mainnet chain notification during recovery signing.
- Revoke a session once and clear private state when a real account/network change is reported or detected by an existing active-session check, even if wallet events were missed. Returning to the original account requires reconnection.
- Preserve recovery signatures, caller-supplied RPC configuration, and pending transaction hashes. Add offline regression coverage for notifications, missed events, signing races, and recovery.

## 0.3.0 — 2026-10-04

- Made Robinhood Chain Mainnet (`4663`) the sole supported network and the canonical `@zkapi/robinhood-sdk` entry point.
- Retained `/mainnet` as a compatibility re-export with the same client, types, and error constructors.
- Required caller-supplied `rpcUrl` in the deployment helper and direct client configuration. Wallet network registration and wallet-free receipt reads use that URL, without a bundled endpoint or API-proxy fallback.
- Preserved the pinned Mainnet pool, proof hashes, signing text, recovery origin, and protocol identity.
- Kept incremental synchronization, session invalidation, confirmation checkpoint guards, same-request retry, and hidden/offline polling behavior.
- Standardized `npm run artifacts` on verified Mainnet proof files in `.artifacts/` and aligned installation, browser integration, and recovery documentation.
- Mainnet integration completed live Deposit/recovery/Send/Max acceptance separately. Standalone checks remain offline; native ETH only, no npm publication or independent audit.
