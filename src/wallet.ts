import { getAddress, hexlify, toUtf8Bytes } from 'ethers';
import { CHAIN_ID, CHAIN_ID_HEX, EXPLORER_URL, requireCondition } from './constants.js';
import { validateRpcUrl } from './rpc.js';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/** Subscribe to wallet announcements; never picks among wallets silently. */
export function discoverWallets(onWallet: (detail: Eip6963ProviderDetail) => void, target: Window = window): () => void {
  const seen = new Set<string>();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (!detail?.info?.uuid || typeof detail.provider?.request !== 'function' || seen.has(detail.info.uuid)) return;
    seen.add(detail.info.uuid);
    onWallet(detail);
  };
  target.addEventListener('eip6963:announceProvider', listener);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => target.removeEventListener('eip6963:announceProvider', listener);
}

export async function assertChain(provider: Eip1193Provider): Promise<void> {
  const chainId = await provider.request({ method: 'eth_chainId' });
  requireCondition(typeof chainId === 'string' && /^0x[0-9a-f]+$/i.test(chainId) && BigInt(chainId) === BigInt(CHAIN_ID), 'WRONG_CHAIN', 'Switch your wallet to Robinhood Chain Mainnet (4663).');
}

export async function switchToMainnet(provider: Eip1193Provider, rpcUrl: string): Promise<void> {
  const endpoint = validateRpcUrl(rpcUrl);
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] }); }
  catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: CHAIN_ID_HEX, chainName: 'Robinhood Chain Mainnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [endpoint], blockExplorerUrls: [EXPLORER_URL],
    }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  }
  await assertChain(provider);
}

export class WalletSession {
  private valid = true;
  private readonly invalidate = () => { this.valid = false; this.onInvalidate?.(); };
  private constructor(public readonly provider: Eip1193Provider, public readonly account: string, private readonly onInvalidate?: () => void) {
    provider.on?.('chainChanged', this.invalidate);
    provider.on?.('accountsChanged', this.invalidate);
    provider.on?.('disconnect', this.invalidate);
  }

  static async connect(provider: Eip1193Provider, options: { switchChain?: boolean; rpcUrl?: string; onInvalidate?: () => void } = {}): Promise<WalletSession> {
    if (options.switchChain) await switchToMainnet(provider, options.rpcUrl!);
    await assertChain(provider);
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    requireCondition(Array.isArray(accounts) && typeof accounts[0] === 'string', 'NO_ACCOUNT', 'No EVM wallet account was selected.');
    const account = getAddress(accounts[0]);
    await assertChain(provider);
    const code = await provider.request({ method: 'eth_getCode', params: [account, 'latest'] });
    requireCondition(code === '0x' || code === '0x0', 'SMART_WALLET_UNSUPPORTED', 'This mainnet release supports EOA wallets only; smart contract and delegated accounts are not supported.');
    return new WalletSession(provider, account, options.onInvalidate);
  }

  async assertActive(): Promise<void> {
    requireCondition(this.valid, 'SESSION_CHANGED', 'Wallet account or network changed. Reconnect to restore the correct private balance.');
    await assertChain(this.provider);
    requireCondition(this.valid, 'SESSION_CHANGED', 'Wallet account or network changed during the chain check.');
    const accounts = await this.provider.request({ method: 'eth_accounts' });
    requireCondition(this.valid, 'SESSION_CHANGED', 'Wallet account or network changed during the account check.');
    requireCondition(Array.isArray(accounts) && typeof accounts[0] === 'string' && getAddress(accounts[0]) === this.account, 'SESSION_CHANGED', 'The selected wallet account changed.');
  }

  async signMessage(message: string): Promise<string> {
    await this.assertActive();
    const signature = await this.provider.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(message)), this.account] });
    requireCondition(typeof signature === 'string', 'INVALID_SIGNATURE', 'Wallet returned an invalid signature.');
    await this.assertActive();
    return signature;
  }

  async sendTransaction(transaction: { to: string; data: string; value: bigint }): Promise<string> {
    await this.assertActive();
    const hash = await this.provider.request({ method: 'eth_sendTransaction', params: [{
      from: this.account, to: getAddress(transaction.to), data: transaction.data,
      value: `0x${transaction.value.toString(16)}`, chainId: CHAIN_ID_HEX,
    }] });
    requireCondition(typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash), 'INVALID_TRANSACTION', 'Wallet returned an invalid transaction hash.');
    return hash;
  }

  disconnect(): void {
    this.valid = false;
    this.provider.removeListener?.('chainChanged', this.invalidate);
    this.provider.removeListener?.('accountsChanged', this.invalidate);
    this.provider.removeListener?.('disconnect', this.invalidate);
  }
}

export function isWalletRejection(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return code === 4001 || code === 'ACTION_REJECTED';
}
