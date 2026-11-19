// Cold native process: the parent installs the real receipt bootstrap before this entry.
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import * as fixture from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { seedRuleFiles } from '../../cli/commands/gate-test-repo-bootstrap';
import { runQualityChecklistCommand } from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import { DEFAULT_OPTIONAL_QUALITY_CHECK_RULES, isOptionalQualityCheckRuleActiveForScope } from '../../../../src/core/workflow-config';
import { assessBoundTrustBoundaryMatrix, TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../../src/core/trust-boundary-analysis';
import { readCapturedClosedReviewGuard } from '../../../../src/gates/review-attempts/review-closed-cycle-capture';
import { readNormalizedReviewCycleGuardConfig } from '../../../../src/gates/next-step/next-step-review-cycle-guard-config';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
function emit(value: unknown): void { process.stdout.write('GARDA_LAZY_RESULT ' + JSON.stringify(value) + '\n'); }
const scenario = process.argv[2], repoRoot = process.argv[3], taskId = 'T-LAZY';
const reviews = fixture.getReviewsRoot(repoRoot), preflightPath = path.join(reviews, taskId + '-preflight.json');
const navigation = path.join(reviews, taskId + '-review-history-navigation.json');
const checklistPath = path.join(reviews, taskId + '-quality-checklist.json');
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
if (scenario === 'seed') {
    seedRuleFiles(repoRoot); fixture.seedRemediationRepoBase(repoRoot);
    fixture.writeReviewCapabilitiesConfig(repoRoot); fixture.writeWorkflowConfig(repoRoot, 'strict_sequential');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src/evidence.ts'), 'export const value=1;\n');
    fixture.initializeGitRepo(repoRoot); fs.writeFileSync(path.join(repoRoot, 'src/evidence.ts'), 'export const value=2;\n');
    fixture.seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced'); fixture.seedInitAnswers(repoRoot, 'Codex');
    const entered = fixture.runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Cold boundary publication', plannedChangedFiles: ['src/evidence.ts'] });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    fixture.loadTaskEntryRulePack(repoRoot, taskId); fixture.runHandshakeForTask(repoRoot, taskId); fixture.runShellSmokeForTask(repoRoot, taskId);
    fixture.runExplicitPreflight(repoRoot, taskId, 'Cold boundary publication', ['src/evidence.ts']);
    fixture.loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    assert.equal(fs.existsSync(navigation), !process.env.NODE_OPTIONS, 'Unavailable receipts must not publish a summary');
    emit({ published: fs.existsSync(navigation) });
} else if (scenario === 'checklist') {
    const preflight = json(preflightPath), previous = json(checklistPath);
    const matrix = previous.answers.find((answer: { rule_id: string }) => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID).trust_boundary_matrix;
    assert.ok(matrix[0].negative_paths[0].evidence_files.length > 0);
    const answers = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.filter(rule => rule.enabled !== false
        && isOptionalQualityCheckRuleActiveForScope(rule, preflight.scope_category, preflight.changed_files)).map(rule => ({
        rule_id: rule.id, status: 'PASS', answer: 'Checked the current fixture boundary and pending native validation.',
        evidence_files: ['src/evidence.ts'], actions_taken: [], actions_required: [],
        ...(rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix } : {})
    }));
    const result = runQualityChecklistCommand({ repoRoot, taskId, preflightPath, answersJson: JSON.stringify(answers), emitMetrics: false });
    const checklist = json(checklistPath);
    assert.notEqual(checklist.status, 'CONFIG_ERROR', result.outputLines.join('\n'));
    assert.equal(checklist.validation_phases?.structural, 'BOUND', result.outputLines.join('\n'));
    assert.ok(checklist.validation_phases.obligations.length > 0);
    emit({ status: checklist.status, exitCode: result.exitCode });
} else {
    let measure!: NextStepMeasurement;
    const before = fs.readFileSync(navigation);
    let result: unknown;
    withNextStepMeasurement(() => {
        if (scenario === 'read') result = resolveNextStep({ repoRoot, taskId });
        else result = withInvocationReadObservation(() => {
            const guard = readCapturedClosedReviewGuard({ repoRoot, taskId,
                eventsRoot: path.join(reviews, '../task-events'), config: readNormalizedReviewCycleGuardConfig(repoRoot) });
            if (scenario === 'order') {
                assert.ok(guard, 'Read must first accept the current native publication');
                const matrix = json(checklistPath).answers.find((answer: { rule_id: string }) => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID).trust_boundary_matrix;
                const assessment = assessBoundTrustBoundaryMatrix(matrix, { repoRoot });
                assert.ok(assessment.source_evidence?.length);
                return true;
            }
            assert.equal(guard, null, 'Missing receipts retain native fallback'); return null;
        });
    }, value => { measure = value; });
    assert.deepEqual(fs.readFileSync(navigation), before, 'Read-only navigation must not rewrite the summary');
    emit({ result, accepted: measure.work['closed-review-summary:accepted'] || 0,
        bindings: measure.work['visit:closed-review-summary:binding'] || 0 });
}
