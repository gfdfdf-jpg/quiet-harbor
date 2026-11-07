import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Only Git output belongs in this digest. A spawn result also contains a changing child pid. */
export function walkWorkspaceFingerprint(root: string, status: string, diff: string): string {
    const untracked = status.split('\0').filter(entry => entry.startsWith('?? ')).map(entry => {
        const relative = entry.slice(3), file = path.resolve(root, relative);
        if (path.relative(root, file).startsWith('..')) throw new Error('Untracked walk path escapes the fixture');
        const stat = fs.lstatSync(file);
        const content = stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file);
        return [relative, createHash('sha256').update(content).digest('hex')];
    });
    return createHash('sha256').update(JSON.stringify({ status, diff, untracked })).digest('hex');
}

/** Missing Git is itself a native refusal case. Keep checking source progress without treating runtime events as edits. */
export function walkNonGitWorkspaceFingerprint(root: string): string {
    const hash = createHash('sha256');
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name), relative = path.relative(root, file).replace(/\\/gu, '/');
            if (relative === 'garda-agent-orchestrator/runtime') continue;
            hash.update(JSON.stringify([relative, entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file']));
            if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(file));
            else if (entry.isDirectory()) visit(file);
            else hash.update(fs.readFileSync(file));
        }
    };
    visit(root);
    return hash.digest('hex');
}

/** Metadata events and changing command hashes cannot make an unchanged multi-gate cycle look like progress. */
export class WalkProgressGuard {
    private readonly visits = new Map<string, number>();
    private readonly policyEpochs = new Map<string, string>();
    private readonly adoptedPolicies = new Set<string>();
    constructor(private readonly limit = 3) {}
    /** A successful operator-approved policy adoption requires a fresh startup/checklist cycle, even on unchanged code. */
    adoptReviewPolicy(taskId: string, digest: string): void {
        if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Progress boundary requires an approved policy digest');
        const key = JSON.stringify([taskId, digest]);
        if (this.adoptedPolicies.has(key)) return;
        this.adoptedPolicies.add(key);
        this.policyEpochs.set(taskId, digest);
    }
    observe(workspace: string, gate: string | null, lane: string, action: string, taskId = ''): boolean {
        const key = JSON.stringify([taskId, this.policyEpochs.get(taskId), workspace, gate, lane, action]);
        const count = (this.visits.get(key) ?? 0) + 1;
        this.visits.set(key, count);
        return count > this.limit;
    }
}
