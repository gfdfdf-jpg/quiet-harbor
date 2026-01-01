import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildWindowsBatchCommandLine, spawnShellCommand } from '../../../src/core/subprocess';
import { seedWalkFixture } from '../synthetic/engine/walk-fixture';
import { STACK_MANIFESTS, readStackExecutions, stackFixture, stackInvocations } from '../synthetic/engine/walk-stack-fixtures';

function installEntryProbe(root: string): void {
    fs.writeFileSync(path.join(root, 'entry.cjs'), [
        'const fs = require("node:fs");',
        'fs.writeFileSync("entry.json", JSON.stringify({ raw: process.env.GARDA_TEST_BATCH_ENTRY, argv: process.argv.slice(2) }));'
    ].join('\n'));
}

function entryProbe(): string {
    // SET retains the raw quoted %* at batch entry. The first Node process
    // independently captures its argv before the ordinary wrapper runs the runner.
    return `set GARDA_TEST_BATCH_ENTRY=%*\r\n"${process.execPath}" entry.cjs %*\r\n`;
}

describe('Windows batch stack argv', { skip: process.platform !== 'win32' }, () => {
    for (const id of ['go', 'cmake', 'polyglot-python-go']) {
        for (const archetype of [1, 3]) {
            for (const extension of ['cmd', 'bat']) {
                it(`${id} A${archetype} preserves manifest selectors through .${extension}`, async () => {
                    const manifest = STACK_MANIFESTS.find(item => item.id === id)!;
                    const invocations = stackInvocations(manifest, archetype);
                    const fixture = stackFixture(manifest, 'generic', invocations);
                    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-stack-'));
                    try {
                        seedWalkFixture(root, fixture);
                        fs.mkdirSync(path.join(root, '.git'));
                        fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify({
                            archetype, mode: 'generic', invocations, repoRoot: root
                        }));
                        for (const suite of manifest.suites) {
                            fs.appendFileSync(path.join(root, suite.target), `\n${suite.comment} STAND_CASE_A${archetype}\n`);
                            fs.appendFileSync(path.join(root, suite.source), `\n${suite.comment} STAND_IMPLEMENT_A${archetype}\n`);
                        }
                        installEntryProbe(root);
                        for (const invocation of invocations) {
                            const technology = manifest.technologies.find(item => item.id === invocation.technology)!;
                            const batch = path.join(root, technology.executable + '.' + extension);
                            const wrapper = fixture.files[technology.executable + '.cmd'];
                            fs.writeFileSync(batch, wrapper.replace('@echo off\r\n', '@echo off\r\n' + entryProbe()));
                            const result = await spawnShellCommand(batch, invocation.argv, { cwd: root, timeoutMs: 10_000 });
                            const entry = JSON.parse(fs.readFileSync(path.join(root, 'entry.json'), 'utf8')) as { raw: string; argv: string[] };
                            assert.deepEqual(entry.argv, invocation.argv, 'argv already differ at batch entry: ' + entry.raw);
                            for (const selector of invocation.argv.filter(arg => arg.includes('^'))) {
                                assert.ok(entry.raw.includes('"' + selector + '"'), 'raw batch entry: ' + entry.raw);
                            }
                            // runner.cjs performs its original exact manifest comparison; no selector normalization.
                            const execution = readStackExecutions(root).at(-1)!;
                            assert.deepEqual(execution.argv, invocation.argv);
                            assert.deepEqual(execution.targets, invocation.targets);
                            assert.equal(execution.error, '');
                            assert.equal(result.exitCode, 0, result.stdout + result.stderr);
                        }
                    } finally {
                        fs.rmSync(root, { recursive: true, force: true });
                    }
                });
            }
        }
    }

    for (const extension of ['cmd', 'bat']) {
        it(`preserves literal metacharacters and a spaced .${extension} path`, async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-literals-'));
            try {
                installEntryProbe(root);
                const batch = path.join(root, `wrapper space & (group)^.${extension}`);
                fs.writeFileSync(batch, '@echo off\r\n' + entryProbe() + 'exit /b 23\r\n');
                const args = ['-R', '^(one|two)$', 'a&b|c<d>e(f)', 'one^two^^three', 'two words', 'C:\\space dir\\'];
                const result = await spawnShellCommand(batch, args, { cwd: root, timeoutMs: 10_000 });
                assert.equal(result.exitCode, 23, result.stdout + result.stderr);
                const entry = JSON.parse(fs.readFileSync(path.join(root, 'entry.json'), 'utf8')) as { argv: string[] };
                assert.deepEqual(entry.argv, args);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }
});

it('keeps unsupported cmd expansion and quote literals fail-closed', () => {
    for (const argument of ['%PATH%', 'bang!', 'embedded"quote', 'line\nbreak', 'line\rbreak', 'nul\0byte']) {
        assert.throws(() => buildWindowsBatchCommandLine('C:\\tools\\runner.cmd', [argument]), /not allowed for Windows batch execution/u);
    }
});
