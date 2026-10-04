import { rm } from 'node:fs/promises';

// A clean build cannot accidentally ship modules removed in a previous release.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
