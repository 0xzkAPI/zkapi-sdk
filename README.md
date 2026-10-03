# zkapi Robinhood SDK

TypeScript SDK for private ETH payments on **Robinhood Chain Testnet (46630)**. Connect an EVM wallet, restore private notes, deposit test ETH, and send ETH to a public recipient with a locally generated zero-knowledge proof.

This is the SDK already used by the zkapi testnet application, extracted into an independent source repository with JavaScript builds, TypeScript declarations, examples, and offline tests. It supports native testnet ETH only. USDG, other tokens, and Mainnet are not supported in this release.

**Source release:** the package name is `@zkapi/robinhood-sdk`, but it has not been published to npm. Build from this repository; do not install an unrelated package with a similar name. `private: true` prevents accidental npm publication. Source is GPL-3.0-only. This testnet code and its development trusted setup have not been independently audited.

## Build from source

Use Node.js 22 or newer:

```sh
git clone https://github.com/0xzkAPI/zkapi-sdk.git
cd zkapi-sdk
npm ci
npm run check
npm run test:package
```

`check` type-checks the SDK and examples, runs the offline tests, then produces ESM JavaScript and `.d.ts` files in `dist/`. The default checks do not connect to a wallet, contact a blockchain, or move funds.

Try an offline fee quote:

```sh
npm run example:quote
```

```js
import { parseEtherExact, formatEtherExact, quoteSend } from './dist/index.js';

const quote = quoteSend(parseEtherExact('0.1'), 20);
console.log({
  grossEth: formatEtherExact(quote.grossWei),
  feeEth: formatEtherExact(quote.feeWei),
  recipientEth: formatEtherExact(quote.netWei),
});
// { grossEth: '0.1', feeEth: '0.00075', recipientEth: '0.09925' }
```

The quote above uses an illustrative 20 basis points. In a connected application, call `client.quoteSend(...)` after loading state to use the pool's current fee.

## Add it to your application

Build and pack the source checkout:

```sh
npm pack
```

Then, from your application:

```sh
npm install /absolute/path/to/zkapi-sdk/zkapi-robinhood-sdk-0.1.0.tgz
```

The package supports Node ESM and browser bundlers. It requires Web Crypto, `fetch`, `BigInt`, and a deterministic EOA wallet exposed as an EIP-1193 provider. Browser signing requires HTTPS or localhost. The SDK does not accept or manage a wallet private key.

## Connect and read a private balance

```ts
import {
  createZkApiClient,
  createRobinhoodTestnetConfig,
  formatEtherExact,
} from '@zkapi/robinhood-sdk';
import type { Eip1193Provider } from '@zkapi/robinhood-sdk';

export async function readBalance(provider: Eip1193Provider) {
  const client = createZkApiClient(createRobinhoodTestnetConfig({
    origin: window.location.origin,
    apiUrl: new URL('/api/robinhood', window.location.origin).href,
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

The application supplies the user-selected provider. `unlock()` requests two matching recovery signatures and reads state; it does not send a transaction. A signature is sensitive recovery material. Never log or persist it.

**The example requires deployment setup.** `/api/robinhood` must be your compatible API or proxy, and `/zkapi-artifacts/` must contain the three pinned proof artifacts. The official service does not promise cross-origin access for third-party apps. See [deployment and browser setup](docs/sdk-usage.md#deployment-and-browser-setup) for exact files, hashes, API behavior, and CORS requirements.

From the SDK source checkout, download and verify the public testnet artifacts:

```sh
npm run artifacts
mkdir -p /path/to/your-app/public/zkapi-artifacts
cp .artifacts/transaction2.wasm .artifacts/transaction2_final.zkey .artifacts/verification_key.json /path/to/your-app/public/zkapi-artifacts/
```

Replace `/path/to/your-app` with your application's directory. The downloader only reads three fixed public URLs, checks SHA-256 and size limits, and writes the verified files to ignored `.artifacts/`. It needs no credentials or wallet. Serve that directory at the `artifactBaseUrl` configured above; artifacts are public files, not secrets. Configure `/api/robinhood` separately as your compatible backend or proxy.

## Preserve recovery identity

The signature text, protocol constants, chain, pool, wallet account, and `origin` define the private identity. The zkapi app deliberately retains the original `https://app.zkpay.sh` recovery origin and zkPay signing text so existing testnet deposits remain recoverable. Renaming those bytes would create different keys.

A new integration should choose and retain its own recovery origin. Its balance will be separate from the official app even for the same wallet. An intentionally compatible recovery integration can explicitly use `LEGACY_RECOVERY_ORIGIN`; explain that compatibility to users and handle signatures only in a trusted application. Neither origin metadata nor domain branding prevents a malicious application from requesting a recovery signature.

`ZkApiClient`, `createZkApiClient`, `ZkApiConfig`, and `ZkApiClientApi` are aliases of the existing implementation. Legacy `ZkPay*` exports remain available. No cryptographic or wire-format identity has changed.

## Deposit, send, and track

- `deposit(amountWei)` proves locally, then asks the wallet to submit a deposit and pay its network gas. The platform deposit fee is zero.
- `send({ grossWei, recipient, expectedFeeBps })` proves locally and submits through the relay. The recipient receives the gross debit minus the fee.
- `sendMax(recipient, { expectedFeeBps })` spends the maximum available in one proof. A proof consumes at most two notes; this can be less than the total private balance.
- `waitForConfirmation(hash, { requestId })` verifies a deposit or send receipt against its original public request fingerprint.
- `retryRelay(requestId)` checks/retries the same send request. It never creates a replacement payment. After a reload, a request unknown to the relay cannot be reconstructed from its ID alone.

Only `status: 'confirmed'` is success. Save public transaction hashes and request IDs when `onProgress` exposes them. A timeout or an unavailable service can mean the transaction is still pending. Do not submit a new payment to compensate for an unknown result.

See the [SDK guide](docs/sdk-usage.md) for quote review, pending recovery, errors, and complete method signatures. The [browser example](examples/browser.ts) exports helpers without connecting or sending on import.

## Security and verification

Read [SECURITY.md](SECURITY.md) for privacy limits, recovery signatures, administrator powers, and service trust. The SDK checks a pinned deployment, public event ordering and Merkle roots, proof artifact hashes, local proof validity, and canonical receipts. These checks do not guarantee anonymity or make the deployment trustless.

The extracted SDK includes 28 upstream offline regression tests plus distribution-specific tests. The original application separately exercised real proofs and a local full-stack environment. Those parent-project integration harnesses are intentionally not copied here, because they depend on separate contracts and Worker checkouts. The standalone default test suite does not claim a fresh live end-to-end payment test or an independent audit.

GitHub Actions is not enabled in this source release. The [CI template](ci/github-actions.yml) runs the offline checks on Node.js 22 and 24. A maintainer with workflow-write permission can enable it by placing that file at `.github/workflows/ci.yml`. Local verification remains available through `npm run check` and `npm run test:package`.

- [Documentation](docs/sdk-usage.md)
- [Testnet application](https://app.zkapi.org/)
- [API and integration guide](docs/sdk-usage.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE) and [dependency notices](THIRD_PARTY.md)
