# zkapi Robinhood SDK

TypeScript SDK for private **ETH** payments on Robinhood Chain. Connect an EVM wallet, recover a private balance, deposit ETH, and send from the shielded pool with a proof generated in your browser.

| Network | Import | Chain ID |
| --- | --- | --- |
| Mainnet | `@zkapi/robinhood-sdk/mainnet` | `4663` |
| Testnet | `@zkapi/robinhood-sdk` | `46630` |

**Bring your own `rpcUrl`.** There is no built-in or fallback RPC. Connected chain reads use the wallet provider you supply; wallet-free receipt recovery uses your configured HTTP RPC. `apiUrl` is the indexer/relay service, not your RPC. Native ETH only; USDG and other tokens are not supported.

This is a GPL-3.0-only **source release**, not an npm publication. `private: true` prevents accidental publication. The root import remains Testnet; Mainnet is an explicit, independent subpath. Version 0.2 requires `rpcUrl` in both configuration helpers and direct client configuration. Existing recovery and protocol identities remain unchanged.

## Build and try an offline quote

Use Node.js 22 or newer:

```sh
git clone https://github.com/0xzkAPI/zkapi-sdk.git
cd zkapi-sdk
npm ci
npm run check
npm run test:package
npm run example:quote
```

The checks use local fixtures, build JavaScript/declarations, and validate a packed consumer. They do not contact a chain, request signatures, or move funds.

```ts
import { parseEtherExact, formatEtherExact, quoteSend } from './dist/mainnet/index.js';

const quote = quoteSend(parseEtherExact('0.1'), 20);
console.log({
  grossEth: formatEtherExact(quote.grossWei),
  feeEth: formatEtherExact(quote.feeWei),
  recipientEth: formatEtherExact(quote.netWei),
});
// { grossEth: '0.1', feeEth: '0.00075', recipientEth: '0.09925' }
```

The 20 basis points above are illustrative. In a connected app, load state and use `client.quoteSend(...)` for the current pool fee. All amounts are `bigint` wei, never JavaScript `Number`.

## Install the built package

From the SDK checkout:

```sh
npm pack
```

From your application:

```sh
npm install /absolute/path/to/zkapi-sdk/zkapi-robinhood-sdk-0.2.0.tgz
```

Use ESM or a browser bundler. Web Crypto, `fetch`, `BigInt`, HTTPS/localhost, and a deterministic EOA wallet with an EIP-1193 provider are required. The SDK does not accept private keys.

## Mainnet: connect and recover

```ts
import {
  createZkApiClient,
  createRobinhoodMainnetConfig,
  formatEtherExact,
  LEGACY_RECOVERY_ORIGIN,
} from '@zkapi/robinhood-sdk/mainnet';
import type { Eip1193Provider } from '@zkapi/robinhood-sdk/mainnet';

export async function readBalance(provider: Eip1193Provider, rpcUrl: string) {
  const client = createZkApiClient(createRobinhoodMainnetConfig({
    rpcUrl, // Your Robinhood Chain Mainnet RPC URL; never a fallback URL.
    origin: LEGACY_RECOVERY_ORIGIN, // Explicitly restore the official app's identity.
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

Call this only after the user selects a wallet and chooses to unlock. `connect()` can request a network switch; if the wallet needs network registration, it receives **your** `rpcUrl`. `unlock()` requests two matching recovery signatures and restores notes; it does not submit a payment. Keep the client connected for a payment flow; this read-only helper disconnects when finished.

The Mainnet helper pins the deployed pool and proof hashes. It defaults to:

- Indexer/relay: `https://app.zkapi.org/api/hood`
- Artifacts: `https://app.zkapi.org/hood/artifacts/zkpay-robinhood-mainnet-v1-4af878b0d007a820/`

You can override `apiUrl` and `artifactBaseUrl`. Third-party browsers may need a same-origin API proxy and their own static artifact host because remote endpoints require CORS access. The RPC must support the selected chain and receipt/block reads. Provider URLs may contain path/query tokens; do not log them. No `.env` or provider credential is read by the package.

## Testnet: use the existing entry point

```ts
import { createZkApiClient, createRobinhoodTestnetConfig } from '@zkapi/robinhood-sdk';

export function createTestnetClient(rpcUrl: string, origin: string) {
  return createZkApiClient(createRobinhoodTestnetConfig({
    rpcUrl, // Your Robinhood Chain Testnet RPC URL, chain 46630.
    origin,
    apiUrl: new URL('/api/robinhood', origin).href,
    artifactBaseUrl: new URL('/zkapi-testnet-artifacts/', origin).href,
  }));
}
```

Supply a compatible API/proxy and the pinned Testnet proof files. A Testnet client rejects a Mainnet configuration, and vice versa. Import each client's types and error predicates from the **same entry point** as that client; the two implementations have separate error constructors.

## Deposit, send, and resume

- `deposit(amountWei)` generates a proof, then asks the wallet to submit and pay gas. Deposit platform fee is zero.
- `send({ grossWei, recipient, expectedFeeBps })` proves and submits through the relay. The recipient receives the gross debit minus the fee.
- `sendMax(recipient, { expectedFeeBps })` spends the maximum available in one two-note proof; this can be less than the total balance.

These methods **submit**, so call them after review and an explicit user action:

```ts
// client is a connected, unlocked Mainnet client.
import { parseEtherExact } from '@zkapi/robinhood-sdk/mainnet';

await client.sync();
const quote = client.quoteSend(parseEtherExact('0.01'));
// Display recipient, gross debit, fee and net; wait for the user's Send action.
const result = await client.send({
  recipient,
  grossWei: quote.grossWei,
  expectedFeeBps: quote.feeBps,
});
```

Send fee: `floor(grossWei × feeBps / 10000) + 550000000000000 wei`. The fixed part is `0.00055 ETH`; the configured percentage may change, so bind the reviewed quote with `expectedFeeBps`.

Only `status: 'confirmed'` is success. Save public request IDs and transaction hashes from `onProgress` as soon as available. For an unknown outcome, resume the **same** payment:

```ts
const resumed = pending.transactionHash
  ? await client.waitForConfirmation(pending.transactionHash, { requestId: pending.requestId })
  : await client.retryRelay(pending.requestId); // Sends only.
```

Do not create a replacement after a timeout, 404, or RPC failure. `isDefiniteTransactionFailure(error)` identifies validated terminal failures. Keep controls blocked for unresolved results. Separate saved tracking by network and pool, and never persist signatures, private notes, keys, or witnesses. A request ID alone cannot rebuild a proof lost before reaching the relay. See [pending recovery](docs/sdk-usage.md#pending-results-and-recovery).

## Proof files and recovery identity

From the **source checkout**, explicitly download and verify the public files:

```sh
npm run artifacts:mainnet # .artifacts/mainnet/
npm run artifacts         # Testnet, existing .artifacts/ location
```

Downloads are allowlisted, size-limited and SHA-256 verified before promotion. They use no wallet or credentials. Serve the three files unchanged at your chosen artifact URL; never mix the networks' proving keys.

The official app keeps `https://app.zkpay.sh` and the original zkPay signing text. `origin`, chain, pool, account and signature bytes define recovery keys. A new integration can explicitly use its own stable origin for a separate balance, or `LEGACY_RECOVERY_ORIGIN` for intentional official-app compatibility. Never rename the cryptographic strings. Treat recovery signatures as secret spending material.

## Troubleshooting and verification

| Symptom | Check |
| --- | --- |
| Missing/invalid RPC | Pass an absolute HTTPS `rpcUrl`, or HTTP loopback for local tests. No default is supplied. |
| Wrong network | Mainnet is 4663; Testnet is 46630. Match the import, RPC, wallet and backend. |
| CORS failure | Configure the caller's RPC, API proxy and artifact host for browser access. |
| Different or empty balance | Check the original recovery origin, pool, network and wallet. |
| `INDEXER_CATCHING_UP` | Keep the balance stale; refresh after the checkpoint catches up. |
| Artifact hash mismatch | Serve the exact pinned files for the chosen network. |
| Pending/unknown transaction | Reconcile the saved request/hash; do not submit another payment. |

The underlying Mainnet integration has completed live Deposit, fresh recovery, Send and Max acceptance. This standalone package's tests are offline regression and distribution checks; they do not repeat live payments. No independent audit is claimed. See [SECURITY.md](SECURITY.md) for privacy limits, administrator powers and trusted-setup assumptions.

This repository contains SDK code and public configuration only, not the frontend, indexer/relay implementation, contracts, or operator material. No npm package has been published. The optional [CI template](ci/github-actions.yml) is not enabled automatically.

- [Integration guide](docs/sdk-usage.md)
- [Mainnet browser example](examples/mainnet-browser.ts) · [Testnet browser example](examples/browser.ts)
- [Application](https://app.zkapi.org/) · [Testnet recovery](https://app.zkapi.org/?chain=robinhood)
- [Changelog](CHANGELOG.md) · [License](LICENSE) · [Dependency notices](THIRD_PARTY.md)
