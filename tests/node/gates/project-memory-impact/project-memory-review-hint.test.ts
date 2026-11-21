import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildProjectMemoryReviewHint,
    findProjectMemoryReviewPointers
} from '../../../../src/gates/project-memory-impact/project-memory-review-hint';
import { resolvePostReviewCloseoutRoute } from '../../../../src/gates/next-step/next-step-closeout-routing';

const RISKS = 'garda-agent-orchestrator/live/docs/project-memory/risks.md';
const MODULE_MAP = 'garda-agent-orchestrator/live/docs/project-memory/module-map.md';
const CHANGED = [
    'src/cli/commands/task-composite/task-composite-runner.ts',
    'tests/node/cli/commands/task-composite-failure.test.ts'
];

let roots: string[] = [];
afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots = [];
});

function memoryFixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-memory-hint-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, path.dirname(RISKS)), { recursive: true });
    fs.writeFileSync(path.join(root, RISKS), [
        '# Risks',
        '',
        '### Composite runner boundaries',
        'Descriptor operations are only shallowly frozen.',
        '### Unrelated',
        'The failure test helper is mentioned here, but tests never point at memory.'
    ].join('\n'));
    fs.writeFileSync(path.join(root, MODULE_MAP), '# Module map\nNothing about the changed module.\n');
    return root;
}

describe('gates/project-memory-impact review hint', () => {
    it('names the candidate lines that mention a changed module', () => {
        const root = memoryFixture();
        assert.deepEqual(findProjectMemoryReviewPointers(root, [MODULE_MAP, RISKS], CHANGED), {
            pointers: [`${RISKS}:3 (### Composite runner boundaries)`], omitted: 0
        });
    });

    it('explains a review without edits instead of implying that memory files were updated', () => {
        const root = memoryFixture();
        const hint = buildProjectMemoryReviewHint({ repoRoot: root, affectedMemoryFiles: [MODULE_MAP, RISKS],
            updatedMemoryFiles: [], changedFiles: CHANGED });
        assert.match(hint, /No candidate memory file is edited\. The command records a review without edits/u);
        assert.match(hint, /--skipped-memory-file/u);
        assert.match(hint, /edit that file first and list it with --updated-memory-file instead/u);
        assert.match(hint, /risks\.md:3 \(### Composite runner boundaries\)/u);

        const edited = buildProjectMemoryReviewHint({ repoRoot: root, affectedMemoryFiles: [MODULE_MAP, RISKS],
            updatedMemoryFiles: [RISKS], changedFiles: CHANGED });
        assert.doesNotMatch(edited, /No candidate memory file is edited/u);
        assert.equal(buildProjectMemoryReviewHint({ repoRoot: root, affectedMemoryFiles: [], updatedMemoryFiles: [],
            changedFiles: CHANGED }), '');
        assert.match(buildProjectMemoryReviewHint({ repoRoot: root, affectedMemoryFiles: [MODULE_MAP],
            updatedMemoryFiles: [], changedFiles: CHANGED }), /No candidate line names a changed module/u);
    });

    it('adds the hint to the project-memory-impact route', () => {
        const route = resolvePostReviewCloseoutRoute({
            requiredReviews: { requiredReviewsGatePassed: true, zeroDiffNoReviewCloseout: false,
                command: { label: 'Review', command: 'review' } },
            docImpact: { docImpactGatePassed: true, compatibilityHint: '', command: { label: 'Docs', command: 'docs' } },
            fullSuite: { enabled: false, gatePassed: true, notRequiredForDocsOnly: false, placement: 'before_completion',
                configPath: 'workflow-config.json', commandText: '', timeoutForecastLine: null,
                command: { label: 'Suite', command: 'suite' } },
            projectMemory: { required: true, evidenceCurrent: false, visibleSummaryLine: 'ProjectMemory: update needed',
                affectedMemoryFiles: [RISKS], violations: [], command: { label: 'Memory', command: 'memory' },
                reviewHint: () => 'REVIEW-HINT' },
            completion: { completionGatePassed: false, command: { label: 'Complete', command: 'complete' } }
        });
        assert.equal(route.nextGate, 'project-memory-impact');
        assert.match(route.reason, / REVIEW-HINT$/u);
    });
});
