import { requireCondition } from './constants.js';

/** Caller-owned endpoint only. Do not include its URL in errors or telemetry. */
export function validateRpcUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new TypeError('rpcUrl must be an absolute HTTPS URL (or HTTP loopback).'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireCondition((url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password && !url.hash,
    'INVALID_RPC_URL', 'rpcUrl requires HTTPS (or HTTP loopback), with no username, password, or fragment.');
  return url.href;
}
