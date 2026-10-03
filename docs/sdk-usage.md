# SDK integration

The SDK supports Robinhood Chain Testnet `46630` and native ETH. It exposes the same payment engine used by the zkapi app. Amounts are `bigint` wei; convert user input with `parseEtherExact`, never JavaScript `Number`.

## Install from source

```sh
git clone https://github.com/0xzkAPI/zkapi-sdk.git
cd zkapi-sdk
npm ci
npm run check
npm pack
```

Install the resulting `zkapi-robinhood-sdk-0.1.0.tgz` into your application using its local file path. No npm release is assumed. Node applications use ESM; browser applications use an ES2022-capable bundler such as Vite or esbuild. Type declarations are included. CommonJS `require()` is not an advertised entry point.

## Deployment and browser setup

`createRobinhoodTestnetConfig` pins the public testnet deployment but makes service endpoints and recovery origin explicit:

```ts
import { createRobinhoodTestnetConfig, createZkApiClient } from '@zkapi/robinhood-sdk';

const config = createRobinhoodTestnetConfig({
  origin: window.location.origin,
  apiUrl: new URL('/api/robinhood', window.location.origin).href,
  artifactBaseUrl: new URL('/zkapi-artifacts/', window.location.origin).href,
});
const client = createZkApiClient(config);
```

This is configuration code, not a working backend provisioner. Serve the compatible HTTP API at your configured `apiUrl`, and place the artifacts below in the artifact directory. In third-party browser applications, use a same-origin backend proxy or a compatible self-hosted indexer/relay. The official backend uses an exact-origin CORS allowlist; an arbitrary application cannot assume direct cross-origin access. Proof files on another origin also need appropriate CORS headers. Browser Web Crypto and wallet flows require HTTPS or localhost.

The helper accepts absolute HTTPS URLs or HTTP loopback URLs, without credentials, query strings, or fragments. For advanced configurations, construct a complete `ZkApiConfig` directly; this still must match chain `46630` and the backend deployment. No endpoint discovery or automatic failover is performed.

| Public identity | Pinned value |
| --- | --- |
| Chain | Robinhood Chain Testnet, `46630` / `0xb626` |
| Pool | `0x5070c561A590bF43D324ac7fcFA70D9d7d767bFA` |
| Verifier | `0xedB7474cbD7121D8E47D352Ac4E0aC0Fcb8AD7Aa` |
| Relayer | `0xDF70f0ACF15D1495849262D8f814E5aDCa0dD92e` |
| Deployment block | `124440222` |
| Artifact ID | `zkpay-robinhood-dev-v1-74c42671f8d4f466` |
| Receipt confirmations | `33`, counting the receipt block |

The public release files are available under `https://zkapi.org/robinhood/artifacts/zkpay-robinhood-dev-v1-74c42671f8d4f466/`. From the SDK source checkout, download and verify them:

```sh
npm run artifacts
mkdir -p /path/to/your-app/public/zkapi-artifacts
cp .artifacts/transaction2.wasm .artifacts/transaction2_final.zkey .artifacts/verification_key.json /path/to/your-app/public/zkapi-artifacts/
```

Replace `/path/to/your-app` with the real application directory. `scripts/download-artifacts.mjs` uses an allowlist of three public HTTPS URLs, rejects redirects, bounds download sizes, and checks every SHA-256 before promoting the temporary files into ignored `.artifacts/`. It does not read credentials, wallets, environment files, or RPC services. Downloading artifacts is an explicit network operation; normal SDK checks remain offline.

With a conventional `public/` directory, the copied files are served at `/zkapi-artifacts/`; set `artifactBaseUrl` to that absolute URL. They are public proof artifacts and may be hosted as static files. Host all three unchanged. The backend/indexer/relay at `apiUrl` is a separate integration requirement, and a remote artifact host needs browser CORS access. Keeping the same bytes is essential; generating a new proving key does not produce a compatible deployment.

| File | SHA-256 |
| --- | --- |
| `transaction2.wasm` | `f66e03b4056ba4c5d230e38c41ba4d81a9347d41222af03b15b47c4a61b4fdf7` |
| `transaction2_final.zkey` | `aa400bb5c9a2c2c3da1ec44c31b9e6e689127339f99c3c04781a0fb92445383f` |
| `verification_key.json` | `b32299593009aaad870ca8a35aa8a2f1a3950f57f898da5a3ac484c323335a4c` |

The SDK downloads and verifies the files only when proving is required. `snarkjs` is loaded lazily. The complete locally generated proof and its public signals are verified before submission. A matching SHA-256 hash proves artifact identity, not that the circuit or ceremony was independently audited.

## Wallet choice and recovery

Use `discoverWallets(callback)` to receive EIP-6963 announcements, show an explicit wallet picker, and pass the user's selected `detail.provider` to `connect`. Call the returned cleanup function when the picker unmounts. Treat wallet names and icons as untrusted content; do not insert them as HTML. A legacy injected provider can also be passed explicitly.

```ts
await client.connect(selectedProvider, { switchChain: true });
const balance = await client.unlock();
```

`connect` validates backend identities, the wallet network, the EOA account, and the on-chain pool verifier/domain. With `switchChain: true`, the wallet may be asked to add/switch to testnet; its suggested public RPC is `https://rpc.testnet.chain.robinhood.com`. Without that option, the caller must already be on the correct network.

`unlock` requests two matching recovery signatures, derives keys in memory, downloads public indexed events, reconstructs the Merkle tree, and restores owned notes. It does not broadcast a transaction. Wallet account/network changes or disconnect events invalidate the session and clear private state.

Keep the exact `origin` stable. The official application deliberately uses `LEGACY_RECOVERY_ORIGIN` (`https://app.zkpay.sh`) so it can restore its earlier deposits. A new integration using its own origin creates a separate private identity. Only use the legacy constant for an intentional compatibility flow and explain the legacy signing message to the user. Never rewrite `zkPay` strings inside the signature, HKDF inputs, note format, protocol domains, or API version.

## Balances and fees

`getSnapshot()` returns the current in-memory `BalanceSnapshot`; `sync()` refreshes it. The relevant fields are:

| Field | Meaning |
| --- | --- |
| `account` | Connected EOA address or `null` |
| `unlocked` | Whether recovery keys are held in memory |
| `walletBalanceWei` | Public wallet balance |
| `privateBalanceWei` | Sum of recovered unspent notes |
| `maxSpendableWei` | Amount that can be consumed in a single two-input proof |
| `noteCount` | Number of recovered unspent notes |
| `state` | Last loaded pool state, or `null` |

Sequential deposits merge notes when possible. Concurrent deposits can leave more than two notes, so `maxSpendableWei` may be smaller than `privateBalanceWei`. A Max action must display the spendable amount accurately; it does not silently consolidate additional notes or charge extra fixed fees.

Deposit platform fee is zero; the depositor pays wallet gas. Send uses a gross private-balance debit:

```text
feeWei = floor(grossWei × feeBps / 10,000) + 550,000,000,000,000
netWei = grossWei − feeWei
```

The fixed part is `0.00055 ETH`. The default percentage is `20` basis points (`0.2%`), and the protocol permits `0..100` basis points. The recipient's net must be positive. Always use the current pool fee from `client.quoteSend(...)` after loading state. A separate exported `quoteSend(grossWei, feeBps)` is useful for offline math; its omitted fee argument defaults to 20 and does not query the chain.

## Deposit and send

Call transaction methods only after explicit user review. They prepare a proof **and submit**; they are not prepare-only methods.

```ts
const deposit = await client.deposit(parseEtherExact('0.1'));
// Check deposit.status; a returned hash alone is not success.
```

For Send, show the recipient, gross debit, fee, and net before the user confirms:

```ts
const quote = client.quoteSend(parseEtherExact('0.01'));
// Display quote and recipient; wait for the user's Send action.
const result = await client.send({
  recipient,
  grossWei: quote.grossWei,
  expectedFeeBps: quote.feeBps,
});
```

Passing `expectedFeeBps` binds the user's review to the current fee. `FEE_CHANGED` requires a refreshed quote and another user action. `sendMax(recipient, { expectedFeeBps })` applies the same guard to the current single-proof maximum. It re-syncs before sending, so display and review the up-to-date amount in your application.

## Pending results and recovery

Transaction methods return `TransactionResult` with `status: 'confirmed' | 'pending'`. Only a confirmed result has a verified `blockNumber`, `kind`, and `recipient`. For deposits, the verified recipient string is empty. Display the success receipt from those verified fields; restored form labels are not evidence.

Register `onProgress` when constructing the client to save **public** `transactionHash` and `requestId` values as soon as they are available. A relay request ID is computed before POST. A deposit's request ID is a fingerprint of its calldata, not a relay submission. Retain public identifiers across reloads if pending recovery is needed, but do not store signatures, keys, plaintext notes, or witnesses.

```ts
if (result.status === 'pending') {
  // Keep the UI pending. Do not create a replacement payment.
  const resumed = result.transactionHash
    ? await client.waitForConfirmation(result.transactionHash, {
        requestId: result.requestId,
      })
    : result.requestId
      ? await client.retryRelay(result.requestId)
      : result;
}
```

Use `retryRelay` only for sends. It first queries the same request. If the relay reports 404 and this live client still has the original proof, it can repost that exact request. After reload, a request ID alone cannot reconstruct a proof that never reached the relay. Keep such an unresolved result pending and reconcile it; do not infer failure from a timeout or 404.

For a saved deposit hash, always pass the saved request ID to `waitForConfirmation` to bind the receipt to the original action. Canonical receipt checks compare the transaction hash, pool, block identity, confirmation depth, calldata, ETH value, and request fingerprint. Provider unavailability remains pending. A confirmed receipt remains confirmed even if the next balance refresh fails.

`isDefiniteTransactionFailure(error)` recognizes `TransactionFailedError` for validated terminal failures. Other exceptions, including `HttpError`, wallet/session changes after submission, and network errors, are not automatically failed payments. Preserve the original identifiers and keep transaction controls blocked until an unknown outcome is reconciled.

## Public client methods

| Method | Result or action |
| --- | --- |
| `createZkApiClient(config)` | Construct a client without contacting the network |
| `connect(provider, { switchChain? })` | Connect and validate; returns a balance snapshot |
| `unlock()` | Request recovery signatures and restore notes |
| `sync()` | Refresh wallet/public event state and restored notes |
| `getSnapshot()` | Read cached balance state synchronously |
| `getState()` | Read and validate pool state |
| `quoteSend(grossWei)` | Quote against the last loaded current fee |
| `deposit(amountWei)` | Prove and request a wallet-funded deposit |
| `send({ grossWei, recipient, expectedFeeBps? })` | Prove and submit a relayed send |
| `sendMax(recipient, { expectedFeeBps? })` | Send the current two-note maximum |
| `waitForConfirmation(hash, { timeoutMs?, requestId? })` | Verify the original transaction receipt |
| `retryRelay(requestId)` | Reconcile/retry the exact pending send |
| `disconnect()` | Remove wallet listeners and clear private state |

`onProgress` phases are `connecting`, `signing`, `syncing`, `encrypting`, `loading-artifacts`, `proving`, `awaiting-wallet`, `relaying`, `confirming`, and `confirmed`. `onSessionInvalidated` lets the UI return to reconnect/unlock when the wallet changes. Public pending transaction tracking is retained separately from cleared keys.

## HTTP transport

The configured `apiUrl` is a base prefix, commonly `/api/robinhood` behind your same-origin proxy. The service must implement:

| Endpoint | Purpose |
| --- | --- |
| `GET /state` | Pinned deployment, fees, pool lifecycle and indexed checkpoint |
| `GET /events?from=…&nullifierFrom=…&limit=…&at=…&epoch=…` | Bounded public commitments/nullifiers for one checkpoint |
| `POST /relay` | Proof/public-data submission for a withdrawal |
| `GET /relay/:requestId` | Reconciliation of the same relay request |
| `POST /rpc` | Restricted read-only chain queries for receipt recovery |

The wire API version remains `zkpay-robinhood-v1`. Amounts/field values use canonical decimal strings; chain ID is the number `46630`; addresses and bytes are hex. The relay accepts proof and public external data, not private keys, recovery signatures, witnesses, or arbitrary transaction calldata. Browser CORS and application proxy policies are deployment responsibilities.

## Testing and limitations

`npm run check` runs offline regression tests with synthetic wallets and mocked transports. `npm run test:package` verifies the file allowlist, secret patterns, Node import, browser bundle execution, packed installation in a fresh consumer, and TypeScript consumer types. These commands do not use an `.env`, connect to a remote RPC, request wallet approval, or broadcast.

No standalone real-proof/full-stack harness is included: the original harnesses depended on parent contracts/Worker source and generated local artifacts. This repository preserves the tested payment implementation, but its distribution tests do not replace deployment testing or an independent audit. Read [the security model](../SECURITY.md) before integration.
