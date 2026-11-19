import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    BASELINE_SKILL_DIRECTORIES,
    RETIRED_BASELINE_SKILL_DIRECTORIES,
    listBuiltinSkillPacks
} from '../../../src/runtime/skill-manifest';

// Related-skill ids that name no shipped skill. Each entry is pinned so the set
// cannot grow silently; remove an entry once its reference is fixed.
const KNOWN_UNSHIPPED_RELATED_SKILLS: Readonly<Record<string, string>> = Object.freeze({
    // Documented custom alternative for the infra lane ("or custom infra-review").
    'infra-review': 'template/skill-packs/devops-k8s/skills/devops-k8s/SKILL.md'
});

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'VERSION')) && fs.existsSync(path.join(current, 'template'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

function listShippedSkillFiles(repoRoot: string): string[] {
    const files: string[] = [];
    for (const skillId of BASELINE_SKILL_DIRECTORIES) {
        files.push(path.join(repoRoot, 'template', 'skills', skillId, 'SKILL.md'));
    }
    for (const pack of listBuiltinSkillPacks(repoRoot)) {
        for (const skillId of pack.skillDirectories) {
            files.push(path.join(repoRoot, 'template', 'skill-packs', pack.id, 'skills', skillId, 'SKILL.md'));
        }
    }
    return files.filter((file) => fs.existsSync(file));
}

function readRelatedSkills(file: string): string[] {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(fs.readFileSync(file, 'utf8'));
    if (!frontmatter) return [];
    const line = /^\s*related-skills:\s*(.*)$/mu.exec(frontmatter[1]);
    return line ? line[1].split(',').map((value) => value.trim()).filter(Boolean) : [];
}

test('every related-skills id names a shipped baseline or pack skill', () => {
    const repoRoot = findRepoRoot();
    const shipped = new Set<string>([
        ...BASELINE_SKILL_DIRECTORIES,
        ...listBuiltinSkillPacks(repoRoot).flatMap((pack) => pack.skillDirectories)
    ]);
    const files = listShippedSkillFiles(repoRoot);
    const unshippedReferences = new Map<string, string[]>();
    let relatedCount = 0;
    for (const file of files) {
        const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
        for (const skillId of readRelatedSkills(file)) {
            relatedCount += 1;
            assert.ok(!RETIRED_BASELINE_SKILL_DIRECTORIES.includes(skillId), `${relative} names retired skill ${skillId}`);
            if (!shipped.has(skillId)) {
                unshippedReferences.set(skillId, [...(unshippedReferences.get(skillId) || []), relative]);
            }
        }
    }
    assert.ok(relatedCount > 0, 'shipped skills declare related-skills');
    assert.deepEqual(
        Object.fromEntries([...unshippedReferences.entries()].map(([skillId, sources]) => [skillId, sources.join(', ')]).sort()),
        Object.fromEntries(Object.entries(KNOWN_UNSHIPPED_RELATED_SKILLS).sort()),
        'related-skills may name only shipped skills or a pinned known exception'
    );
});
