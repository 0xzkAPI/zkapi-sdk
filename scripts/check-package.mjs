import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@zkapi/robinhood-sdk');
assert.equal(manifest.private, true, 'npm publication remains a separate release decision.');
assert.equal(manifest.license, 'GPL-3.0-only');
const npm = (args, cwd = root) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const [packed] = JSON.parse(npm(['pack', '--dry-run', '--ignore-scripts', '--json']));
for (const expected of ['dist/index.js', 'dist/index.d.ts', 'src/index.ts', 'dist/mainnet/index.js', 'dist/mainnet/index.d.ts', 'src/mainnet/index.ts', 'LICENSE', 'THIRD_PARTY.md']) {
  assert.ok(packed.files.some(file => file.path === expected), `Missing ${expected}`);
}
for (const file of packed.files) {
  assert.match(file.path, /^(?:dist\/|src\/|notices\/|docs\/|examples\/|README\.md$|SECURITY\.md$|CHANGELOG\.md$|LICENSE$|THIRD_PARTY\.md$|package\.json$|tsconfig(?:\.build)?\.json$)/);
  assert.doesNotMatch(file.path, /(?:\.env|\.sk$|keypair\.json|\.pem$|node_modules|\.artifacts|\.tgz$|(?:^|\/)(?:frontend|worker|contracts|deployments|operator|handoff)\/)/);
  if (file.path.includes('mainnet/')) assert.match(file.path, /^(?:src|dist)\/mainnet\//);
  const content = await readFile(join(root, file.path), 'utf8');
  assert.ok(!/(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(content), `Credential-like content in ${file.path}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Unexpected network request on import.'); };
try {
  const sdk = await import('../dist/index.js');
  assert.equal(sdk.parseEtherExact('1.000000000000000001'), 1000000000000000001n);
  assert.equal(sdk.createZkApiClient, sdk.createZkPayClient);
  assert.equal(sdk.ZkApiClient, sdk.ZkPayClient);
  assert.equal(sdk.CHAIN_ID, 46630);
  const mainnet = await import('../dist/mainnet/index.js');
  assert.equal(mainnet.CHAIN_ID, 4663);
  assert.equal(mainnet.createZkApiClient, mainnet.createZkPayClient);
  assert.equal('PUBLIC_RPC_URL' in sdk, false);
  assert.equal('PUBLIC_RPC_URL' in mainnet, false);
} finally { globalThis.fetch = originalFetch; }

for (const entry of ['dist/index.js', 'dist/mainnet/index.js']) {
 const result = await build({
  entryPoints: [join(root, entry)], bundle: true, platform: 'browser',
  target: 'es2022', format: 'iife', globalName: 'ZkApiSDK', write: false, logLevel: 'silent',
});
const sandbox = createContext({
  console, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa,
  AbortController, AbortSignal, Uint8Array, ArrayBuffer, DataView,
  fetch: () => { throw new Error('Unexpected browser import request.'); },
  setTimeout: () => { throw new Error('Unexpected browser import timer.'); },
  clearTimeout: () => {},
});
runInContext(result.outputFiles[0].text, sandbox, { timeout: 10_000 });
assert.equal(runInContext('ZkApiSDK.formatEtherExact(ZkApiSDK.quoteSend(ZkApiSDK.parseEtherExact("0.1"), 20).netWei)', sandbox), '0.09925');
assert.equal(runInContext('ZkApiSDK.createZkApiClient === ZkApiSDK.createZkPayClient', sandbox), true);
 assert.equal(runInContext('ZkApiSDK.CHAIN_ID', sandbox), entry.includes('/mainnet/') ? 4663 : 46630);
}

// Install the actual tarball into a fresh offline consumer: no registry or parent paths.
const consumer = await mkdtemp(join(tmpdir(), 'zkapi-sdk-consumer-'));
try {
  const [archive] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer]));
  const dependency = `file:${join(consumer, archive.filename)}`;
  const consumerManifest = { name: 'zkapi-sdk-consumer', version: '1.0.0', private: true, type: 'module', dependencies: { [manifest.name]: dependency }, overrides: manifest.overrides };
  await writeFile(join(consumer, 'package.json'), JSON.stringify(consumerManifest));
  // Reuse the committed integrity-pinned runtime tree so npm never needs registry
  // metadata. npm ci above has already cached these exact tarballs.
  const sourceLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const runtimePackages = Object.fromEntries(Object.entries(sourceLock.packages).filter(([path, pkg]) => path && !pkg.dev));
  const consumerLock = {
    name: consumerManifest.name, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: consumerManifest.name, version: '1.0.0', dependencies: consumerManifest.dependencies },
      ...runtimePackages,
      [`node_modules/${manifest.name}`]: { version: manifest.version, resolved: dependency, integrity: archive.integrity, license: manifest.license, dependencies: manifest.dependencies, engines: manifest.engines },
    },
  };
  await writeFile(join(consumer, 'package-lock.json'), JSON.stringify(consumerLock));
  npm(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  await writeFile(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
globalThis.fetch = () => { throw new Error('Unexpected consumer network request.'); };
const sdk = await import('@zkapi/robinhood-sdk');
assert.equal(sdk.formatEtherExact(sdk.quoteSend(sdk.parseEtherExact('0.1'), 20).feeWei), '0.00075');
assert.equal(sdk.createZkApiClient, sdk.createZkPayClient);
const config = sdk.createRobinhoodTestnetConfig({origin:'https://consumer.example',rpcUrl:'https://consumer.example/testnet-rpc',apiUrl:'https://consumer.example/api/robinhood',artifactBaseUrl:'https://consumer.example/artifacts/'});
assert.equal(sdk.createZkApiClient(config).getSnapshot().unlocked, false);
const mainnet = await import('@zkapi/robinhood-sdk/mainnet');
const mainnetConfig = mainnet.createRobinhoodMainnetConfig({origin:mainnet.LEGACY_RECOVERY_ORIGIN,rpcUrl:'https://consumer.example/mainnet-rpc'});
assert.equal(mainnetConfig.chainId, 4663);
assert.equal(mainnetConfig.apiUrl, 'https://app.zkapi.org/api/hood');
assert.equal(mainnet.createZkApiClient(mainnetConfig).getSnapshot().unlocked, false);
assert.throws(() => sdk.createZkApiClient(mainnetConfig), /46630/);
`);
  execFileSync(process.execPath, [join(consumer, 'smoke.mjs')], { cwd: consumer, stdio: 'pipe' });
  await writeFile(join(consumer, 'smoke.ts'), `
import { createZkApiClient, createRobinhoodTestnetConfig, parseEtherExact } from '@zkapi/robinhood-sdk';
import type { ZkApiClient, ZkApiConfig, Eip1193Provider, TransactionResult } from '@zkapi/robinhood-sdk';
const config: ZkApiConfig = createRobinhoodTestnetConfig({origin:'https://consumer.example',rpcUrl:'https://consumer.example/testnet-rpc',apiUrl:'https://consumer.example/api/robinhood',artifactBaseUrl:'https://consumer.example/artifacts/'});
const client: ZkApiClient = createZkApiClient(config);
export async function connect(provider: Eip1193Provider) { return client.connect(provider); }
export async function deposit(): Promise<TransactionResult> { return client.deposit(parseEtherExact('0.1')); }
import { createZkApiClient as createMainnetClient, createRobinhoodMainnetConfig } from '@zkapi/robinhood-sdk/mainnet';
import type { ZkApiConfig as MainnetConfig, TransactionResult as MainnetResult } from '@zkapi/robinhood-sdk/mainnet';
const mainnetConfig: MainnetConfig = createRobinhoodMainnetConfig({origin:'https://consumer.example',rpcUrl:'https://consumer.example/mainnet-rpc'});
const mainnetClient = createMainnetClient(mainnetConfig);
export async function mainnetDeposit(): Promise<MainnetResult> { return mainnetClient.deposit(parseEtherExact('0.1')); }
// @ts-expect-error Mainnet configuration cannot be used with the Testnet client.
createZkApiClient(mainnetConfig);
// @ts-expect-error Callers must supply their own Mainnet RPC.
createRobinhoodMainnetConfig({origin:'https://consumer.example'});
// @ts-expect-error Callers must supply their own Testnet RPC.
createRobinhoodTestnetConfig({origin:'https://consumer.example',apiUrl:'https://consumer.example/api',artifactBaseUrl:'https://consumer.example/artifacts'});
`);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', join(consumer, 'smoke.ts')], { cwd: consumer, stdio: 'pipe' });
} finally { await rm(consumer, { recursive: true, force: true }); }

console.log(`Package allowlist and credential scan passed (${packed.files.length} files).`);
console.log('Node import, browser bundle, offline packed installation, consumer runtime, and consumer TypeScript checks passed.');
