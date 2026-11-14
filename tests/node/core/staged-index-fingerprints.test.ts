import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseStageIndexAuthority, readStagedBlobFingerprints } from '../../../src/core/staged-index-fingerprints';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

describe('core/staged-index-fingerprints', () => {
    it('preserves POSIX backslashes while rejecting Windows separators and traversal', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const record = (file: string) => `100644 ${'a'.repeat(40)} 0\t${file}\0`;
        try {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            assert.equal(parseStageIndexAuthority(record('literal\\name.txt'))[0].path, 'literal\\name.txt');
            for (const file of ['../escape', '/absolute', 'src/../escape', 'src//empty'])
                assert.throws(() => parseStageIndexAuthority(record(file)), /malformed record/u);
            Object.defineProperty(process, 'platform', { value: 'win32' });
            assert.throws(() => parseStageIndexAuthority(record('literal\\name.txt')), /malformed record/u);
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }
    });

    it('reads requested staged blobs in one index snapshot and ignores dirty worktree content', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-staged-index-fingerprints-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'tracked.ts'), 'export const value = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'space name.ts'), 'export const spaced = true;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/tracked.ts', 'src/space name.ts']);

            const alphaFingerprints = readStagedBlobFingerprints(repoRoot, [
                'src/tracked.ts',
                'src/space name.ts',
                'src/missing.ts'
            ]);
            assert.equal(alphaFingerprints.size, 2);
            assert.match(alphaFingerprints.get('src/tracked.ts') || '', /^staged:100644:[0-9a-f]{40,64}$/u);
            assert.match(alphaFingerprints.get('src/space name.ts') || '', /^staged:100644:[0-9a-f]{40,64}$/u);

            fs.writeFileSync(path.join(repoRoot, 'src', 'tracked.ts'), 'export const value = "bravo";\n', 'utf8');
            const dirtyFingerprints = readStagedBlobFingerprints(repoRoot, ['src/tracked.ts']);
            assert.equal(dirtyFingerprints.get('src/tracked.ts'), alphaFingerprints.get('src/tracked.ts'));

            runGit(repoRoot, ['add', 'src/tracked.ts']);
            const bravoFingerprints = readStagedBlobFingerprints(repoRoot, ['src/tracked.ts']);
            assert.notEqual(bravoFingerprints.get('src/tracked.ts'), alphaFingerprints.get('src/tracked.ts'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects nonempty staged authority outside a Git worktree', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-staged-index-no-repo-'));
        try {
            assert.throws(() => readStagedBlobFingerprints(repoRoot, ['src/missing.ts']), /git .*ls-files.*failed/u);
            assert.deepEqual([...readStagedBlobFingerprints(repoRoot, [])], []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
