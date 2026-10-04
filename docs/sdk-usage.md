# SDK integration

Version 0.3 supports native ETH on Robinhood Chain Mainnet `4663` only; USDG and other tokens are not implemented. Amounts are `bigint` wei; convert user input with `parseEtherExact`, never JavaScript `Number`.

## Install from source

```sh
git clone https://github.com/0xzkAPI/zkapi-sdk.git
cd zkapi-sdk
npm ci
npm run check
npm pack
```

Install the resulting `zkapi-robinhood-sdk-0.3.0.tgz` into your application using its local file path. No npm release is assumed. Node applications use ESM; browser applications use an ES2022-capable bundler such as Vite or esbuild. Type declarations are included. CommonJS `require()` is not an advertised entry point.

## Configure Mainnet and your RPC

Import the client, `createRobinhoodMainnetConfig`, types, and error predicates from `@zkapi/robinhood-sdk`. Every client uses Mainnet and can move real ETH when a transaction method is called. The optional `/mainnet` compatibility subpath re-exports the same implementation and constructors; it does not create a separate client identity.

The helper and direct `ZkApiConfig` objects **require a caller-supplied `rpcUrl`**. The SDK does not bundle a default RPC, discover one from the API, or fall back to another provider.

Connected chain reads use the selected EIP-1193 wallet provider. Receipt recovery without an active wallet session uses HTTP JSON-RPC at your `rpcUrl`. When a wallet needs `wallet_addEthereumChain`, the SDK supplies this same caller-selected URL. Adding a chain does not guarantee that a wallet replaces an already configured RPC. Wallet signing and deposit submission remain wallet operations.

Your `apiUrl` independently selects the public-event indexer and relay. Choosing an RPC does not replace those services, and receipt recovery does not fall back to an API `/rpc` route. The caller-selected RPC must support Robinhood Chain Mainnet and the historical reads needed to verify receipts.

RPC URLs require HTTPS, except explicit HTTP loopback development. Embedded usernames, passwords, and fragments are rejected. Provider paths and query parameters are allowed; they may contain API credentials. Do not log the URL or expose a server-only credential in browser configuration. The URL is also shared with the wallet when adding the chain.

## Deployment and browser setup

`createRobinhoodMainnetConfig` requires `origin` and `rpcUrl`; `apiUrl` and `artifactBaseUrl` are optional. Its defaults are `MAINNET_API_URL` (`https://app.zkapi.org/api/hood`) and `MAINNET_ARTIFACT_BASE_URL` (`https://app.zkapi.org/hood/artifacts/zkpay-robinhood-mainnet-v1-4af878b0d007a820/`). These defaults are service locations, not an availability or cross-origin access guarantee. A third-party browser integration should explicitly configure accessible endpoints:

```ts
import {
  createRobinhoodMainnetConfig,
  createZkApiClient,
  formatEtherExact,
} from '@zkapi/robinhood-sdk';
import type { Eip1193Provider } from '@zkapi/robinhood-sdk';

export async function readMainnetBalance(provider: Eip1193Provider, rpcUrl: string) {
  const client = createZkApiClient(createRobinhoodMainnetConfig({
    origin: window.location.origin,
    rpcUrl,
    apiUrl: new URL('/api/hood', window.location.origin).href,
    artifactBaseUrl: new URL('/zkapi-artifacts/', window.location.origin).href,
  }));
  try {
    await client.connect(provider, { switchChain: true });
    const balance = await client.unlock();
    return {
      totalEth: formatEtherExact(balance.privateBalanceWei),
      spendableEth: formatEtherExact(balance.maxSpendableWei),
    };
  } finally {
    client.disconnect();
  }
}
```

This helper reads Mainnet state and requests sensitive recovery signatures; it does not submit a transaction. The examples assume your application serves a compatible API/proxy and the correct proof files. This repository contains the SDK, not frontend, Worker, contract, or operator deployment source.

Third-party browsers cannot assume the official API's exact-origin CORS policy permits them. Supply a same-origin proxy or compatible self-hosted indexer/relay. Your HTTP RPC and remote proof host must separately permit browser access. Browser Web Crypto and wallet flows require HTTPS or localhost. A proxy needs no recovery signature, secret key, or witness.

The helper accepts absolute HTTPS API/artifact URLs or HTTP loopback URLs, without embedded credentials, query strings, or fragments. RPC validation is separate and permits query parameters. A directly constructed `ZkApiConfig` must still match Mainnet and pinned backend identity.

| Public identity | Pinned value |
| --- | --- |
| Chain ID | `4663` / `0x1237` |
| Pool | `0xF3A2D484d909C48C8581B99750B28D5F9af3E1E6` |
| Verifier | `0x952F13f3c6a41B291f250EF8D0b56986E1F89da0` |
| Relayer | `0x0D7fd3755ca7122db807B21BAc09Bc327a9A7289` |
| Deployment block | `72985549` |
| Artifact ID | `zkpay-robinhood-mainnet-v1-4af878b0d007a820` |
| Helper receipt confirmations, including receipt block | `33` |
| Wire API version | `zkpay-robinhood-mainnet-v1` |

## Proving artifacts

From the **SDK source checkout**, download and verify the pinned Mainnet proving files:

```sh
npm run artifacts
mkdir -p /path/to/your-app/public/zkapi-artifacts
cp .artifacts/transaction2.wasm .artifacts/transaction2_final.zkey .artifacts/verification_key.json /path/to/your-app/public/zkapi-artifacts/
```

Replace `/path/to/your-app` with the real application directory. The command writes verified Mainnet files to ignored `.artifacts/`. `scripts/download-artifacts.mjs` selects three fixed public HTTPS URLs, rejects redirects, bounds sizes, and checks all three SHA-256 hashes before promoting temporary files. It does not read credentials, wallets, environment files, or RPC services. Downloading artifacts is an explicit network operation; normal SDK checks remain offline. The downloader script is not included in the installed tarball. `npm run artifacts:mainnet` is an alias for the same command and destination.

Files are published at `MAINNET_ARTIFACT_BASE_URL` above. For self-hosting, set `artifactBaseUrl` to your application directory. These are public files, not secrets. Host all three unchanged; generating a new proving key does not produce a compatible deployment.

| File | SHA-256 |
| --- | --- |
| `transaction2.wasm` | `f66e03b4056ba4c5d230e38c41ba4d81a9347d41222af03b15b47c4a61b4fdf7` |
| `transaction2_final.zkey` | `1760a70b18e0344facc7513e4bef845c722fc35e39c1b6993da5217f65ef3a7f` |
| `verification_key.json` | `de305d44edadaddbbdd140a2431c3cf4d07be7a901610481eeef4ad97c0b5943` |

The SDK downloads and verifies the files only when proving is required. `snarkjs` is loaded lazily. The complete locally generated proof and its public signals are verified before submission. A matching SHA-256 hash proves artifact identity, not that the circuit or ceremony was independently audited.

## Wallet choice and recovery

Use `discoverWallets(callback)` to receive EIP-6963 announcements, show an explicit wallet picker, and pass the user's selected `detail.provider` to `connect`. Call the returned cleanup function when the picker unmounts. Treat wallet names and icons as untrusted content; do not insert them as HTML. A legacy injected provider can also be passed explicitly.

```ts
await client.connect(selectedProvider, { switchChain: true });
const balance = await client.unlock();
```

`connect` validates backend identities, the wallet network, the EOA account, and the on-chain pool verifier/domain. With `switchChain: true`, the wallet may be asked to add/switch to the entry point's network; chain registration uses your `rpcUrl`. Without that option, the caller must already be on the correct network.

`unlock` requests two matching recovery signatures, derives keys in memory, downloads public indexed events, reconstructs the Merkle tree, and restores owned notes. It does not broadcast a transaction. Wallet account/network changes or disconnect events invalidate the session and clear private state.

Keep the exact `origin` stable. The official app retains `LEGACY_RECOVERY_ORIGIN` (`https://app.zkpay.sh`), its original signing text, and the `zkpay-robinhood-mainnet-v1` recovery protocol. A new integration using its own origin creates another private identity, even for the same wallet and pool. Only use the legacy constant for an intentional compatibility flow and explain the legacy signing message to the user. Never rewrite `zkPay` strings inside the signature, HKDF inputs, note format, protocol domains, or API version.

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
    : submittedKind === 'send' && result.requestId
      ? await client.retryRelay(result.requestId)
      : result;
}
```

Here `submittedKind` is the operation your application recorded before submission. Use `retryRelay` only for sends. It first queries the same request. If the relay reports 404 and this live client still has the original proof, it can repost that exact request. After reload, a request ID alone cannot reconstruct a proof that never reached the relay. Keep such an unresolved result pending and reconcile it; do not infer failure from a timeout or 404.

For a saved deposit hash, always pass the saved request ID to `waitForConfirmation` to bind the receipt to the original action. Canonical receipt checks compare the transaction hash, pool, block identity, confirmation depth, calldata, ETH value, and request fingerprint. Provider unavailability remains pending. A confirmed receipt remains confirmed even if the next balance refresh fails. Retain its public reconciliation record until a fresh, non-indexing balance checkpoint reaches the confirmed block; a page reload must not turn an older balance into spendable funds.

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

The configured `apiUrl` is an indexer/relay base prefix, commonly `/api/hood` behind your same-origin proxy. The service must implement:

| Endpoint | Purpose |
| --- | --- |
| `GET /state` | Pinned deployment, fees, pool lifecycle and indexed checkpoint |
| `GET /events?from=…&nullifierFrom=…&limit=…&at=…&epoch=…` | Bounded public commitments/nullifiers for one checkpoint |
| `POST /relay` | Proof/public-data submission for a withdrawal |
| `GET /relay/:requestId` | Reconciliation of the same relay request |

The wire API version is `zkpay-robinhood-mainnet-v1`. Amounts/field values use canonical decimal strings; the chain ID is the number `4663`; addresses and bytes are hex. The relay accepts proof and public external data, not private keys, recovery signatures, witnesses, or arbitrary transaction calldata.

HTTP chain reads are JSON-RPC POSTs sent directly to your required `rpcUrl`, not `${apiUrl}/rpc`. Browser CORS and application proxy policies are deployment responsibilities for each transport.

## Troubleshooting

| Symptom | Check and next action |
| --- | --- |
| Missing or invalid `rpcUrl` | Provide an explicit HTTPS endpoint for Robinhood Chain Mainnet. The helper has no default RPC. |
| `WRONG_CHAIN` or deployment mismatch | Match the wallet, RPC, and API to Mainnet chain `4663` and the pinned deployment. |
| Browser CORS failure | Configure browser access separately for API, RPC, and artifact host; a working wallet connection does not configure HTTP access. |
| Expected balance is absent | Check the original wallet, recovery origin, chain, and pool before depositing again. Different identity inputs restore different balances. |
| Indexer catching up or stale checkpoint | Keep spending disabled and refresh when public history reaches the required block. |
| Artifact integrity error | Serve the three pinned Mainnet files unchanged. Clear incorrect deployment assets instead of disabling hash checks. |
| RPC unavailable or payment pending | Preserve the original hash/request ID and resume checks with the configured provider. Do not create a replacement payment or assume failure. |

## Testing and limitations

`npm run check` runs offline regression tests with synthetic wallets and mocked transports. `npm run test:package` verifies the file allowlist, secret patterns, Node import, browser bundle execution, packed installation in a fresh consumer, and TypeScript consumer types. These commands do not use an `.env`, connect to a remote RPC, request wallet approval, or broadcast.

The parent application has separately exercised real Mainnet Deposit, recovery, Send, and Max flows. The standalone package's current checks are offline; they do not repeat those live payments. No standalone real-proof/full-stack harness or frontend/Worker/contracts/operator source is included. Distribution tests do not replace deployment testing or an independent audit. Read [the security model](../SECURITY.md) before integration.
