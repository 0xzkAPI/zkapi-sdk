export * from './constants.js';
export * from './fees.js';
export * from './wallet.js';
export * from './keys.js';
export * from './types.js';
export * from './protocol.js';
export * from './tree.js';
export * from './notes.js';
export * from './api.js';
export * from './proof.js';
export * from './client.js';
export * from './deployment.js';

// Branding aliases preserve the original implementation and recovery identity.
export { ZkPayClient as ZkApiClient, createZkPayClient as createZkApiClient } from './client.js';
export { ZkPayApi as ZkApiHttpClient } from './api.js';
export { ZkPayError as ZkApiError } from './constants.js';
export type { ZkPayConfig as ZkApiConfig, ZkPayClientApi as ZkApiClientApi } from './types.js';
