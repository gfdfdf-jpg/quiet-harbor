import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export interface ReleasedRetiredSkillCopy {
    skillId: string;
    digest: string;
    releases: string[];
    files: Record<string, string>;
}

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'VERSION')) && fs.existsSync(path.join(current, 'template'))) return current;
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

/**
 * Copies of the retired skills exactly as released, from the 1.0.0 npm package
 * through the 2.0 pre-removal state, one entry per distinct content.
 */
export function readReleasedRetiredSkillCopies(): ReleasedRetiredSkillCopy[] {
    const fixture = path.join(findRepoRoot(), 'tests', 'fixtures', 'retired-skills', 'released-copies.json.br');
    const parsed = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(fixture)).toString('utf8')) as {
        schema: number;
        copies: ReleasedRetiredSkillCopy[];
    };
    if (parsed.schema !== 1) throw new Error('Unexpected released retired skill fixture schema.');
    return parsed.copies;
}

/** The newest released copy of one retired skill. */
export function latestReleasedRetiredSkillCopy(skillId: string): ReleasedRetiredSkillCopy {
    const copy = readReleasedRetiredSkillCopies().filter((candidate) => candidate.skillId === skillId).at(-1);
    if (!copy) throw new Error(`No released copy for ${skillId}.`);
    return copy;
}

/** Writes a released copy into `<bundleRoot>/live/skills/<id>` byte-for-byte, as init and update install it. */
export function writeRetiredSkillCopy(bundleRoot: string, copy: ReleasedRetiredSkillCopy): string {
    const skillRoot = path.join(bundleRoot, 'live', 'skills', copy.skillId);
    for (const [relative, text] of Object.entries(copy.files)) {
        const filePath = path.join(skillRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, text, 'utf8');
    }
    return skillRoot;
}

export function readTree(root: string): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(entryPath);
            else files.set(path.relative(root, entryPath).replace(/\\/g, '/'), fs.readFileSync(entryPath));
        }
    }
    return files;
}
