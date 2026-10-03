import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ROBINHOOD_TESTNET_DEPLOYMENT } from '../dist/deployment.js';

// Public, fixed allowlist. No environment files, credentials, wallet, or RPC.
const sourceBase = 'https://zkapi.org/robinhood/artifacts/zkpay-robinhood-dev-v1-74c42671f8d4f466/';
const artifacts = [
  { file: 'transaction2.wasm', hash: ROBINHOOD_TESTNET_DEPLOYMENT.artifactHashes.wasm, maxBytes: 32 * 1024 * 1024 },
  { file: 'transaction2_final.zkey', hash: ROBINHOOD_TESTNET_DEPLOYMENT.artifactHashes.zkey, maxBytes: 256 * 1024 * 1024 },
  { file: 'verification_key.json', hash: ROBINHOOD_TESTNET_DEPLOYMENT.artifactHashes.verificationKey, maxBytes: 1024 * 1024 },
];
const allowedUrls = new Set(artifacts.map(({ file }) => new URL(file, sourceBase).href));
const destination = fileURLToPath(new URL('../.artifacts/', import.meta.url));
await mkdir(destination, { recursive: true });
const staging = await mkdtemp(join(destination, '.download-'));

try {
  for (const artifact of artifacts) {
    const url = new URL(artifact.file, sourceBase).href;
    assert.ok(allowedUrls.has(url), 'Artifact URL is not allowlisted.');
    const response = await fetch(url, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
    assert.ok(response.ok && response.body, `${artifact.file}: HTTP ${response.status}`);
    const declaredSize = response.headers.get('content-length');
    if (declaredSize !== null) {
      assert.ok(/^\d+$/.test(declaredSize) && Number(declaredSize) <= artifact.maxBytes, `${artifact.file}: declared size exceeds limit.`);
    }
    let bytes = 0;
    const hash = createHash('sha256');
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > artifact.maxBytes) return callback(new Error(`${artifact.file}: download exceeds size limit.`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(join(staging, artifact.file), { flags: 'wx' }));
    assert.ok(bytes > 0, `${artifact.file}: empty download.`);
    assert.equal(hash.digest('hex'), artifact.hash, `${artifact.file}: SHA-256 does not match the pinned release.`);
    console.log(`Verified ${artifact.file} (${bytes} bytes).`);
  }
  // Nothing is promoted until all three files pass their identity checks.
  for (const { file } of artifacts) await rename(join(staging, file), join(destination, file));
  console.log('Verified testnet artifacts saved to .artifacts/. Copy these three files to your application artifact directory.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
