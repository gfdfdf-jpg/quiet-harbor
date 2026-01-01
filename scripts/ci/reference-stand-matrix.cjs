'use strict';
const fs = require('node:fs');

const REVIEW_STACKS = ['rotation', 'seeded', 'all'];

function shardCount(value, name) {
    const total = Number(value);
    if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(total) || total < 1 || total > 128) {
        throw new Error(name + ' must be 1..128 (at most 256 matrix jobs)');
    }
    return total;
}

/**
 * Each OS has its own shard count and deep review selection. Review logic is OS independent, so Linux can carry every
 * deep family on every stack while Windows, about four times slower on ACL and process start-up, keeps the complete
 * full level with the seeded deep rotation and more shards. Both still merge into their own complete verdict.
 */
function referenceStandMatrix(env) {
    const systems = [
        { os: 'linux', runner: 'ubuntu-latest', total: shardCount(env.STAND_LINUX_SHARDS || '10', 'linux_shards'),
            review_stacks: env.STAND_LINUX_REVIEW_STACKS || 'all' },
        { os: 'windows', runner: 'windows-latest', total: shardCount(env.STAND_WINDOWS_SHARDS || '16', 'windows_shards'),
            review_stacks: env.STAND_WINDOWS_REVIEW_STACKS || 'seeded' }
    ];
    if (!['full', 'sweep'].includes(env.STAND_LEVEL)) throw new Error('level must be full or sweep');
    if (!['linux', 'windows', 'both'].includes(env.STAND_OS)) throw new Error('os must be linux, windows or both');
    for (const system of systems) {
        if (!REVIEW_STACKS.includes(system.review_stacks)) throw new Error(system.os + '_review_stacks must be rotation, seeded or all');
    }
    if (!['Codex', 'Claude'].includes(env.STAND_PROVIDER)) throw new Error('provider must be Codex or Claude');
    const seed = Number(env.STAND_SEED);
    if (!/^\d+$/u.test(env.STAND_SEED) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be uint32');
    const selectedSystems = systems.filter(system => env.STAND_OS === 'both' || env.STAND_OS === system.os);
    const selected = env.STAND_ONLY_SHARD ? Number(env.STAND_ONLY_SHARD) : null;
    if (selected !== null && (!/^\d+$/u.test(env.STAND_ONLY_SHARD) || !Number.isSafeInteger(selected) || selected < 1
        || selectedSystems.some(system => selected > system.total))) throw new Error('only_shard must be 1..shards of every selected OS');
    return {
        shards: { include: selectedSystems.flatMap(system => Array.from({ length: system.total }, (_, offset) => offset + 1)
            .filter(index => selected === null || selected === index)
            .map(index => ({ os: system.os, runner: system.runner, shard: index, total: system.total, review_stacks: system.review_stacks }))) },
        systems: { include: selectedSystems.map(system => ({ os: system.os, runner: system.runner })) }
    };
}
module.exports = { referenceStandMatrix };
if (require.main === module) {
    const matrix = referenceStandMatrix(process.env);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'shards=' + JSON.stringify(matrix.shards) + '\nsystems=' + JSON.stringify(matrix.systems) + '\n');
}
