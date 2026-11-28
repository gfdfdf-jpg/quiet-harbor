import { createRequire } from 'node:module';

// c8 11 requests yargs 17's extensionless CommonJS factory inside a type:module
// package. Node 26 correctly treats that entry as ESM. The explicit .cjs public
// entry exports the same factory; retain the alias only in this coverage child.
const c8Require = createRequire(require.resolve('c8/package.json'));
const factory = c8Require('yargs') as unknown;
const factoryModule = require.cache[c8Require.resolve('yargs')];
if (!factoryModule || typeof factory !== 'function') {
    throw new Error('c8 requires a CommonJS yargs factory.');
}
require.cache[c8Require.resolve('yargs/yargs')] = factoryModule;
require('c8/bin/c8.js');
