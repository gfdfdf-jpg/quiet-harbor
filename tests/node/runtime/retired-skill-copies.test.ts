import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    classifyRetiredSkillCopies,
    classifyRetiredSkillCopy,
    computeSkillTreeDigest,
    getShippedRetiredSkillDigests
} from '../../../src/runtime/retired-skill-copies';
import { SHIPPED_RETIRED_SKILL_DIGESTS } from '../../../src/runtime/retired-skill-digests';
import { RETIRED_BASELINE_SKILL_DIRECTORIES } from '../../../src/runtime/skill-manifest';
import {
    latestReleasedRetiredSkillCopy as copyFor,
    readReleasedRetiredSkillCopies,
    writeRetiredSkillCopy
} from './retired-skill-fixtures';

function bundle(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-retired-copy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
    return bundleRoot;
}

test('embedded digests cover every released copy of both retired skills', () => {
    assert.deepEqual(Object.keys(SHIPPED_RETIRED_SKILL_DIGESTS).sort(), [...RETIRED_BASELINE_SKILL_DIRECTORIES].sort());
    assert.equal(getShippedRetiredSkillDigests('orchestration').length, 49);
    assert.equal(getShippedRetiredSkillDigests('orchestration-depth1').length, 16);
    for (const digests of Object.values(SHIPPED_RETIRED_SKILL_DIGESTS)) {
        assert.ok(Object.isFrozen(digests));
        assert.equal(new Set(digests).size, digests.length);
        for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/u);
    }
    assert.deepEqual(getShippedRetiredSkillDigests('code-review'), []);
    const copies = readReleasedRetiredSkillCopies();
    const releases = new Set(copies.flatMap((copy) => copy.releases));
    for (const release of ['1.0.0 (npm package)', '1.1.0', '1.2.0', '1.3.0', '1.4.0 (release commit)', '1.4.1 (release commit)',
        '1.4.2', '1.4.3', '1.4.4 (origin/master)', '1.4.4 (origin/dev)', '2.0 pre-removal (25c13f48)']) {
        assert.ok(releases.has(release), release);
    }
    for (const copy of copies) {
        const digest = computeSkillTreeDigest(Object.entries(copy.files).map(([relative, text]) => ({
            path: relative,
            sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
        })));
        assert.equal(digest, copy.digest, `${copy.skillId} ${copy.releases.join(', ')}`);
        assert.ok(getShippedRetiredSkillDigests(copy.skillId).includes(digest), `${copy.skillId} ${copy.releases.join(', ')}`);
    }
});

test('every released copy is recognised as shipped', (t) => {
    for (const copy of readReleasedRetiredSkillCopies()) {
        const bundleRoot = bundle(t);
        writeRetiredSkillCopy(bundleRoot, copy);
        const classification = classifyRetiredSkillCopy(bundleRoot, copy.skillId);
        assert.equal(classification.state, 'shipped', `${copy.skillId} ${copy.releases.join(', ')}: ${classification.reason}`);
        assert.equal(classification.reason, 'unmodified copy shipped by an earlier release');
    }
});

test('a missing copy is absent and a non-retired id is refused', (t) => {
    const bundleRoot = bundle(t);
    assert.deepEqual(classifyRetiredSkillCopies(bundleRoot).map((entry) => entry.state), ['absent', 'absent']);
    assert.throws(() => classifyRetiredSkillCopy(bundleRoot, 'code-review'), /Not a retired baseline skill id/u);
});

test('any change to the file set or bytes makes a copy modified', (t) => {
    const variants: Array<[string, (skillRoot: string) => void]> = [
        ['one byte changed', (skillRoot) => {
            const file = path.join(skillRoot, 'SKILL.md');
            const bytes = fs.readFileSync(file);
            bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x2e ? 0x21 : 0x2e;
            fs.writeFileSync(file, bytes);
        }],
        ['extra file', (skillRoot) => fs.writeFileSync(path.join(skillRoot, 'notes.md'), 'My notes.\n')],
        ['missing file', (skillRoot) => fs.rmSync(path.join(skillRoot, 'references', 'stage-gates.md'))],
        ['extra empty directory', (skillRoot) => fs.mkdirSync(path.join(skillRoot, 'drafts'))],
        ['line endings converted', (skillRoot) => {
            const file = path.join(skillRoot, 'skill.json');
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/gu, '\r\n'));
        }]
    ];
    for (const [label, mutate] of variants) {
        const bundleRoot = bundle(t);
        const skillRoot = writeRetiredSkillCopy(bundleRoot, copyFor('orchestration'));
        mutate(skillRoot);
        const classification = classifyRetiredSkillCopy(bundleRoot, 'orchestration');
        assert.equal(classification.state, 'modified', label);
        assert.equal(classification.binding, undefined, label);
    }
});

test('links are never followed: a linked copy, a link inside it or a hard link is reported as a link', (t) => {
    const outside = bundle(t);
    const linkedRoot = writeRetiredSkillCopy(outside, copyFor('orchestration-depth1'));

    const directoryLink = bundle(t);
    fs.symlinkSync(linkedRoot, path.join(directoryLink, 'live', 'skills', 'orchestration-depth1'), 'junction');
    assert.equal(classifyRetiredSkillCopy(directoryLink, 'orchestration-depth1').state, 'link');

    const innerLink = bundle(t);
    const innerRoot = writeRetiredSkillCopy(innerLink, copyFor('orchestration'));
    fs.rmSync(path.join(innerRoot, 'references'), { recursive: true });
    const referencesTarget = path.join(path.dirname(innerLink), 'references-target');
    fs.mkdirSync(referencesTarget);
    fs.symlinkSync(referencesTarget, path.join(innerRoot, 'references'), 'junction');
    assert.equal(classifyRetiredSkillCopy(innerLink, 'orchestration').state, 'link');

    const hardLink = bundle(t);
    const hardRoot = writeRetiredSkillCopy(hardLink, copyFor('orchestration-depth1'));
    fs.linkSync(path.join(hardRoot, 'SKILL.md'), path.join(path.dirname(hardLink), 'SKILL-hard-link.md'));
    assert.equal(classifyRetiredSkillCopy(hardLink, 'orchestration-depth1').state, 'link');
});
