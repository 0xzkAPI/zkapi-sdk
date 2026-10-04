import type { ZkPayConfig } from './types.js';
import { CHAIN_ID, requireCondition } from './constants.js';
import { normalizedDomain } from './keys.js';
import { validateRpcUrl } from './rpc.js';

/** Compatibility domain for deposits made through the official zkPay/zkapi app. */
export const LEGACY_RECOVERY_ORIGIN = 'https://app.zkpay.sh' as const;
export const MAINNET_API_URL = 'https://app.zkapi.org/api/hood' as const;
export const MAINNET_ARTIFACT_BASE_URL = 'https://app.zkapi.org/hood/artifacts/zkpay-robinhood-mainnet-v1-4af878b0d007a820/' as const;

/** Public mainnet release identities. No wallet or network access occurs on import. */
export const ROBINHOOD_MAINNET_DEPLOYMENT = Object.freeze({
  chainId: CHAIN_ID,
  poolAddress: '0xF3A2D484d909C48C8581B99750B28D5F9af3E1E6',
  verifierAddress: '0x952F13f3c6a41B291f250EF8D0b56986E1F89da0',
  relayerAddress: '0x0D7fd3755ca7122db807B21BAc09Bc327a9A7289',
  deploymentBlock: 72985549,
  artifactId: 'zkpay-robinhood-mainnet-v1-4af878b0d007a820',
  // Worker uses 32 following blocks; the SDK also counts the receipt block.
  confirmations: 33,
  artifactHashes: Object.freeze({
    wasm: 'f66e03b4056ba4c5d230e38c41ba4d81a9347d41222af03b15b47c4a61b4fdf7',
    zkey: '1760a70b18e0344facc7513e4bef845c722fc35e39c1b6993da5217f65ef3a7f',
    verificationKey: 'de305d44edadaddbbdd140a2431c3cf4d07be7a901610481eeef4ad97c0b5943',
  }),
});

export interface RobinhoodMainnetOptions {
  /** Caller-owned Robinhood JSON-RPC URL. No built-in or fallback endpoint. */
  rpcUrl: string;
  /** Explicit recovery identity. Use LEGACY_RECOVERY_ORIGIN only for intentional official-app recovery. */
  origin: string;
  /** Defaults to MAINNET_API_URL; third-party browsers may need a same-origin proxy. */
  apiUrl?: string;
  /** Defaults to MAINNET_ARTIFACT_BASE_URL; an alternate host must serve the same pinned bytes. */
  artifactBaseUrl?: string;
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

/** Explicit Mainnet (4663) entry point; it never accepts a Testnet deployment. */
export function createRobinhoodMainnetConfig(options: RobinhoodMainnetOptions): ZkPayConfig {
  const deployment = ROBINHOOD_MAINNET_DEPLOYMENT;
  normalizedDomain({ origin: options.origin, chainId: CHAIN_ID, poolAddress: deployment.poolAddress, account: deployment.relayerAddress });
  const apiUrl = serviceUrl(options.apiUrl ?? MAINNET_API_URL, 'apiUrl').href.replace(/\/$/, '');
  const artifactBase = serviceUrl(options.artifactBaseUrl ?? MAINNET_ARTIFACT_BASE_URL, 'artifactBaseUrl').href.replace(/\/?$/, '/');
  const artifact = (file: string, sha256: string) => Object.freeze({ url: new URL(file, artifactBase).href, sha256 });
  const { artifactHashes, ...identity } = deployment;
  return Object.freeze({
    ...identity, origin: options.origin, apiUrl, rpcUrl: validateRpcUrl(options.rpcUrl),
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
