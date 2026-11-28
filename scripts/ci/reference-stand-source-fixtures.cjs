"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PIN_FILE = 'tests/node/synthetic/engine/walk-field-cases.ts';

function requiredFieldProducerTree(source) {
    const matches = [...source.matchAll(/^export const FIELD_LEGACY_GARDA_TREE = '([a-f0-9]{40})';\r?$/gmu)];
    if (matches.length !== 1) throw new Error('Expected exactly one literal pinned historical field-producer tree.');
    return matches[0][1];
}

function assertFieldProducerTreeAvailable(root = process.cwd()) {
    const tree = requiredFieldProducerTree(fs.readFileSync(path.join(root, PIN_FILE), 'utf8'));
    const result = spawnSync('git', ['cat-file', '-t', tree], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536
    });
    if (result.error || result.status !== 0) throw new Error(
        `Pinned historical field-producer tree ${tree} is unavailable. `
        + 'Attach this exact tree to the reserve snapshot and fetch its parent before starting stand shards.');
    if (result.stdout.trim() !== 'tree') throw new Error(`Pinned historical field producer ${tree} must be a tree, found ${result.stdout.trim()}.`);
    return tree;
}

module.exports = { requiredFieldProducerTree, assertFieldProducerTreeAvailable };
if (require.main === module) {
    try { console.log(JSON.stringify({ field_fixture_tree: assertFieldProducerTreeAvailable(), available: true })); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
