import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';
import { assertNativeCompletedCommit, nativeReviewMatrixScenario } from './review-matrix-native';
import { STACK_MANIFESTS } from './walk-stack-fixtures';

const TASK = 'T-WALK';
const CARD = 'docs/tasks/consent.md';
const LANES = ['code', 'db', 'security', 'refactor', 'api', 'performance', 'test'];

/** OP-038: acceptance criteria must survive FULL, DELTA and retained FULL evidence through native closeout. */
export function onlineStoreCloseoutScenario(): WalkScenario {
    const manifest = structuredClone(STACK_MANIFESTS.find(item => item.id === 'spring-maven')!);
    const suite = manifest.suites[0];
    suite.target = path.posix.join(path.posix.dirname(suite.target), 'security', path.posix.basename(suite.target));
    const base = nativeReviewMatrixScenario(manifest, {
        id: 't022-1-closeout',
        rule: 'Test-only remediation must preserve the unrelated accepted reviews and all acceptance criteria.',
        required: LANES.filter(lane => lane !== 'code' && lane !== 'test'),
        repairs: [{ lane: 'test', attempt: 1, kind: 'test', lines: 32 }],
        launches: [...LANES.map(lane => lane + ':FULL'), 'security:FULL', 'refactor:DELTA', 'test:DELTA']
    }, 'strict_sequential');
    return {
        ...base,
        get testSelectionCommand() { return base.testSelectionCommand; },
        id: 'field-onlinestore-t022-1-closeout',
        // This field project has a security integration test and a lower structural threshold than the common matrix.
        taskNotes: `[${TASK}](${CARD}#t-walk)`,
        configure: root => {
            base.configure?.(root);
            const file = path.join(root, 'garda-agent-orchestrator/live/config/paths.json');
            const paths = JSON.parse(fs.readFileSync(file, 'utf8'));
            paths.test_refactor_changed_lines_threshold = 20;
            fs.writeFileSync(file, JSON.stringify(paths));
        },
        setup: root => {
            base.setup?.(root);
            const file = path.join(root, CARD);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '# T-WALK\n\n## Acceptance criteria\n- Consent is validated.\n'
                + '- Recorded consent cannot be changed.\n- Rejection does not persist an order.\n');
            runGit(root, ['add', '--', CARD]);
            runGit(root, ['commit', '-qm', 'Seed the consent task card in the disposable fixture']);
        },
        inspectResult: async (root, result) => {
            await base.inspectResult?.(root, result);
            const audit = buildTaskAuditSummary({ taskId: TASK, repoRoot: root });
            assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers));
            assert.equal(audit.review_coverage_summary?.status, 'COMPLETE');
            assert.equal(audit.final_closeout.status, 'READY');
            const { json, markdown, final_user_report: reportPath } = audit.final_closeout.artifact_paths;
            assert.ok(json && markdown && reportPath);
            const closeout = JSON.parse(fs.readFileSync(json, 'utf8'));
            assert.equal(closeout.audit_status, 'PASS');
            assert.equal(closeout.status, 'READY');
            assert.ok(fs.statSync(markdown).isFile());
            assert.match(fs.readFileSync(reportPath, 'utf8'), /Status: DONE/u);
            for (const lane of LANES) {
                const context = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews',
                    `${TASK}-${lane}-review-context.json`), 'utf8'));
                const criteria = (context.coverage_contract.obligations as { id: string; kind: string }[])
                    .filter(item => item.kind === 'criterion').map(item => item.id);
                assert.deepEqual(criteria, ['ACCEPTANCE-001', 'ACCEPTANCE-002', 'ACCEPTANCE-003'], lane);
            }
            await assertNativeCompletedCommit(root, true);
        }
    };
}
