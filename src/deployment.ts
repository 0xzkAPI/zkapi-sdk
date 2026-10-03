import type { ZkPayConfig } from './types.js';
import { CHAIN_ID, requireCondition } from './constants.js';
import { normalizedDomain } from './keys.js';

/** Compatibility domain for deposits made through the official zkPay/zkapi app. */
export const LEGACY_RECOVERY_ORIGIN = 'https://app.zkpay.sh' as const;

/** Public release identities. This does not choose an API endpoint or recovery origin. */
export const ROBINHOOD_TESTNET_DEPLOYMENT = Object.freeze({
  chainId: CHAIN_ID,
  poolAddress: '0x5070c561A590bF43D324ac7fcFA70D9d7d767bFA',
  verifierAddress: '0xedB7474cbD7121D8E47D352Ac4E0aC0Fcb8AD7Aa',
  relayerAddress: '0xDF70f0ACF15D1495849262D8f814E5aDCa0dD92e',
  deploymentBlock: 124440222,
  artifactId: 'zkpay-robinhood-dev-v1-74c42671f8d4f466',
  // Worker uses 32 following blocks; SDK counts the receipt block as one.
  confirmations: 33,
  artifactHashes: Object.freeze({
    wasm: 'f66e03b4056ba4c5d230e38c41ba4d81a9347d41222af03b15b47c4a61b4fdf7',
    zkey: 'aa400bb5c9a2c2c3da1ec44c31b9e6e689127339f99c3c04781a0fb92445383f',
    verificationKey: 'b32299593009aaad870ca8a35aa8a2f1a3950f57f898da5a3ac484c323335a4c',
  }),
});

export interface RobinhoodTestnetOptions {
  /** Explicit recovery identity. Keep this stable for the lifetime of deposits. */
  origin: string;
  /** Compatible indexer/relay base URL, normally your own same-origin proxy. */
  apiUrl: string;
  /** Directory containing the three files pinned by this release. */
  artifactBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  onProgress?: ZkPayConfig['onProgress'];
  onSessionInvalidated?: ZkPayConfig['onSessionInvalidated'];
  confirmationTimeoutMs?: number;
  confirmationPollMs?: number;
}

function serviceUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new TypeError(`${label} must be an absolute HTTP(S) URL.`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireCondition((url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password && !url.search && !url.hash,
    'INVALID_DEPLOYMENT', `${label} requires HTTPS (or HTTP loopback) with no credentials, query, or fragment.`);
  return url;
}

export function createRobinhoodTestnetConfig(options: RobinhoodTestnetOptions): ZkPayConfig {
  const deployment = ROBINHOOD_TESTNET_DEPLOYMENT;
  normalizedDomain({ origin: options.origin, chainId: CHAIN_ID, poolAddress: deployment.poolAddress, account: deployment.relayerAddress });
  const apiUrl = serviceUrl(options.apiUrl, 'apiUrl').href.replace(/\/$/, '');
  const artifactBase = serviceUrl(options.artifactBaseUrl, 'artifactBaseUrl').href.replace(/\/?$/, '/');
  const artifact = (file: string, sha256: string) => Object.freeze({ url: new URL(file, artifactBase).href, sha256 });
  const { artifactHashes, ...identity } = deployment;
  return Object.freeze({
    ...identity, origin: options.origin, apiUrl,
    artifacts: Object.freeze({
      wasm: artifact('transaction2.wasm', artifactHashes.wasm),
      zkey: artifact('transaction2_final.zkey', artifactHashes.zkey),
      verificationKey: artifact('verification_key.json', artifactHashes.verificationKey),
    }),
    fetch: options.fetch, onProgress: options.onProgress,
    onSessionInvalidated: options.onSessionInvalidated,
    confirmationTimeoutMs: options.confirmationTimeoutMs,
    confirmationPollMs: options.confirmationPollMs,
  });
}
