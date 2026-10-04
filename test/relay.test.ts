import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, isDefiniteRelayRejection } from '../src/api.js';
import { createZkPayClient } from '../src/client.js';
import { field, isDefiniteTransactionFailure } from '../src/constants.js';
import { extDataHash, poolDomain, relayRequestId } from '../src/protocol.js';
import type { ProvedTransaction } from '../src/proof.js';
import { config, HASH, POOL, RECIPIENT, RELAYER } from './fixtures.js';

function publicRequest(): ProvedTransaction {
  const extData = { recipient: RECIPIENT, extAmount: '-99250000000000000', feeRecipient: RELAYER, fee: '750000000000000', encryptedOutput1: '0x01', encryptedOutput2: '0x02' };
  const proof = { pA: ['0', '0'] as [string, string], pB: [['0', '0'], ['0', '0']] as [[string, string], [string, string]], pC: ['0', '0'] as [string, string], root: '1', inputNullifiers: ['2', '3'] as [string, string], outputCommitments: ['4', '5'] as [string, string], publicAmount: field(-100000000000000000n).toString(), extDataHash: extDataHash(POOL, extData).toString(), poolDomain: poolDomain(POOL).toString() };
  return { proof, extData, publicSignals: [proof.root, proof.publicAmount, proof.extDataHash, ...proof.inputNullifiers, ...proof.outputCommitments, proof.poolDomain] };
}
function pendingClient(fetcher: typeof fetch) {
  const proved = publicRequest(), requestId = relayRequestId(POOL, proved.proof, proved.extData);
  const client = createZkPayClient({ ...config, fetch: fetcher });
  // Recreate an already prepared public request. No spend keys, plaintext notes
  // or witness are needed to exercise transport recovery via public retryRelay.
  Object.assign(client, { pending: { requestId, transactionHash: null, proved } });
  return { client, requestId, proved };
}
const notFound = () => Response.json({ error: { code: 'NOT_FOUND', message: 'Unknown relay request' } }, { status: 404 });

test('only known application pre-broadcast rejections are definitive', () => {
  for (const [status, code] of [[400, 'INVALID_INPUT'], [409, 'INCORRECT_FEE'], [422, 'INVALID_PROOF'], [413, 'BODY_LIMIT']] as const) assert.equal(isDefiniteRelayRejection(new HttpError(code, code, status)), true);
  for (const [status, code] of [[429, 'RATE_LIMITED'], [429, 'SERVICE_BUSY'], [409, 'REORG_RETRY'], [409, 'RELAYER_BUSY'], [408, 'REQUEST_TIMEOUT'], [503, 'RPC_REJECTED'], [422, 'RPC_EXECUTION_REVERTED'], [400, 'EDGE_PROXY_ERROR'], [429, 'INVALID_INPUT']] as const) assert.equal(isDefiniteRelayRejection(new HttpError(code, code, status)), false);
});

test('rate limits, reorgs, busy responses and proxy failures preserve and retry the exact public proof', async () => {
  const responses = [
    Response.json({ error: { code: 'RATE_LIMITED', message: 'Retry later' } }, { status: 429 }),
    Response.json({ error: { code: 'REORG_RETRY', message: 'Chain changed' } }, { status: 409 }),
    Response.json({ error: { code: 'RELAYER_BUSY', message: 'Busy' } }, { status: 409 }),
    Response.json({ error: { code: 'REQUEST_TIMEOUT', message: 'Timeout' } }, { status: 408 }),
    Response.json({ error: { code: 'RPC_REJECTED', message: 'Provider overloaded' } }, { status: 503 }),
    Response.json({ error: { code: 'EDGE_PROXY_ERROR', message: 'Unknown proxy error' } }, { status: 400 }),
    new Response('<html>Rate limited</html>', { status: 429 }),
  ];
  const submitted: string[] = [];
  let requestId = '';
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes('/relay/') && !init?.body) return notFound();
    submitted.push(String(init?.body));
    return responses.shift() ?? Response.json({ status: 'pending', requestId, transactionHash: null }, { status: 202 });
  };
  const fixture = pendingClient(fetcher); requestId = fixture.requestId;
  for (let index = 0; index < 8; index++) {
    const result = await fixture.client.retryRelay(requestId);
    assert.equal(result.status, 'pending'); assert.equal(result.requestId, requestId);
    await assert.rejects(fixture.client.deposit(1n), (error: unknown) => (error as { code?: string }).code === 'TRANSACTION_PENDING');
  }
  assert.equal(submitted.length, 8);
  assert.ok(submitted.every((body) => body === submitted[0]));
  assert.deepEqual(JSON.parse(submitted[0]), { chainId: 4663, pool: POOL, proof: fixture.proved.proof, extData: fixture.proved.extData });
});

test('an explicit invalid-proof rejection releases only its pending request', async () => {
  const fixture = pendingClient(async (input) => String(input).includes('/relay/') ? notFound() : Response.json({ error: { code: 'INVALID_PROOF', message: 'Proof verification failed' } }, { status: 422 }));
  await assert.rejects(fixture.client.retryRelay(fixture.requestId), (error: unknown) => isDefiniteTransactionFailure(error) && error.requestId === fixture.requestId);
  await assert.rejects(fixture.client.deposit(1n), (error: unknown) => (error as { code?: string }).code === 'BALANCE_LOCKED');
});

test('unknown, malformed or reorganized failed labels cannot release pending state', async () => {
  for (const error of ['UNKNOWN_FAILURE', 'NONCE_CONFLICT', 'CONFIRMATION_REORG']) {
    let requestId = '';
    const fixture = pendingClient(async () => Response.json({ requestId, status: 'failed', transactionHash: null, error }));
    requestId = fixture.requestId;
    assert.equal((await fixture.client.retryRelay(requestId)).status, 'pending');
    await assert.rejects(fixture.client.deposit(1n), (cause: unknown) => (cause as { code?: string }).code === 'TRANSACTION_PENDING');
  }
  let requestId = '';
  const fixture = pendingClient(async () => Response.json({ requestId, status: 'failed', transactionHash: null, error: { unexpected: true } }));
  requestId = fixture.requestId;
  assert.equal((await fixture.client.retryRelay(requestId)).status, 'pending');
});

test('known unsigned preparation failure is definitive but a hash requires an on-chain receipt', async () => {
  let requestId = '';
  const unsigned = pendingClient(async () => Response.json({ requestId, status: 'failed', transactionHash: null, error: 'PRE_SIGN_REJECTED' }));
  requestId = unsigned.requestId;
  await assert.rejects(unsigned.client.retryRelay(requestId), isDefiniteTransactionFailure);

  const signed = pendingClient(async (input, init) => {
    if (String(input).endsWith('/rpc')) {
      const request = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x1237' : null });
    }
    return Response.json({ requestId, status: 'failed', transactionHash: HASH, error: 'TRANSACTION_REVERTED' });
  });
  requestId = signed.requestId;
  assert.equal((await signed.client.retryRelay(requestId)).status, 'pending');
  await assert.rejects(signed.client.deposit(1n), (cause: unknown) => (cause as { code?: string }).code === 'TRANSACTION_PENDING');
});
