import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mock, test } from 'node:test';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { runRecipeCommand } from '../../../../src/cli/commands/gate-flows/command-run/recipe-command-flow';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { inspectQualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { readValidationEvents, withValidationEvidenceBatch,
    type ValidationEvidenceBatch } from '../../../../src/gates/project-validation/attempt-evidence';
import { activationFixture } from './fixtures/activation-fixture';
import { ValidationInspectionRaceError } from '../../../../src/core/project-validation-errors';
import { readInspectionFailureFacts } from '../../../../src/gates/next-step/next-step-quality-checklist-readiness';
import { readQualityValidationPhaseAnalysis } from '../../../../src/gates/review-context/review-context-trust-boundary-analysis';

// Counter hooks call the real production readers in isolated native Git fixtures.
const git = require('../../../../src/core/git-helpers') as typeof import('../../../../src/core/git-helpers');
const identity = require('../../../../src/core/project-validation-identity') as typeof import('../../../../src/core/project-validation-identity');

async function executedFixture(targetId?: string) {
    const fixture = activationFixture({ prefix: '', packageCwd: false }, 'tap', 4, targetId);
    try {
        execFileSync('git', ['add', '--', fixture.source], { cwd: fixture.repoRoot, stdio: 'pipe' });
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            taskIntent: 'Inspect four authenticated recipe results', outputPath: fixture.preflightPath,
            useStaged: true, emitMetrics: false });
        for (const recipe of fixture.declaration.recipes) {
            const response = await runRecipeCommand({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, recipeId: recipe.id });
            assert.equal(response.exitCode, 0, response.outputLines.join('\n'));
        }
        const inspect = () => inspectQualityValidationPhases({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            preflight: JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')),
            preflightSha256: createHash('sha256').update(fs.readFileSync(fixture.preflightPath)).digest('hex'),
            matrixRequired: false, matrix: [] })!;
        return { ...fixture, inspect };
    } catch (error) { fixture.cleanup(); throw error; }
}

function assertObserved(phases: ReturnType<typeof inspectQualityValidationPhases>) {
    assert.ok(phases);
    assert.equal(phases.phases.execution, 'OBSERVED');
    assert.equal(phases.phases.semantic, 'PENDING_INDEPENDENT_REVIEW');
    assert.deepEqual(phases.phases.executions.map(result => result.result_status), Array(4).fill('PASSED'));
    assert.equal(new Set(phases.phases.executions.map(result => result.attempt_id)).size, 4);
    assert.equal(phases.phases.obligations.length, 4);
}

test('four recipe inspection shares native staged-scope reads while retaining four distinct results', async () => {
    const fixture = await executedFixture();
    const original = git.runGitBinary;
    let stagedReads = 0;
    const hook = mock.method(git, 'runGitBinary', function (...args: Parameters<typeof original>) {
        if (args[1][0] === 'ls-files') stagedReads++;
        return original(...args);
    });
    try {
        assertObserved(fixture.inspect());
        assert.equal(stagedReads, 2, 'Inspect the native staged scope once at opening and once at closing.');
    } finally { hook.mock.restore(); fixture.cleanup(); }
});

for (const targetId of ['proof', 'approved-\ud800']) test(`an approved checklist target ${JSON.stringify(targetId)} retains recipe-wide observation`, async () => {
    const fixture = await executedFixture(targetId);
    try {
        const bytes = fs.readFileSync(fixture.preflightPath);
        const result = inspectQualityValidationPhases({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            preflight: JSON.parse(bytes.toString('utf8')), preflightSha256: createHash('sha256').update(bytes).digest('hex'),
            matrixRequired: true, matrix: [{ boundary_id: 'B-1', boundary: 'Input to authority', authority_source: 'Product',
                mutable_inputs: ['input'], integrity_evidence: ['expected value'], canonical_reconstruction: 'Read the value.',
                toctou_replay: 'Repeat with stale input.', negative_paths: [{ kind: 'other', scenario: 'wrong input',
                    expected_behavior: 'Reject the input.', evidence_files: [fixture.target + '#' + targetId] }] }] });
        assert.equal(fs.readFileSync(path.join(fixture.repoRoot, fixture.target), 'utf8').includes(targetId), false);
        assert.equal(result?.phases.structural, 'BOUND');
        assert.equal(result?.phases.execution, 'OBSERVED');
        assert.ok(result.phases.obligations.every(target => target.execution === 'OBSERVED'));
        assert.ok(result.phases.executions.every(recipe => recipe.execution === 'OBSERVED'));
        assert.deepEqual(result.phases.execution_diagnostics, []);
        assert.ok(result.phases.obligations.every(target => target.target_id === targetId));
    } finally { fixture.cleanup(); }
});

test('recipe inspection rejects source drift during retained reads and accepts restored current source', async () => {
    const fixture = await executedFixture(), sourcePath = path.join(fixture.repoRoot, fixture.source);
    const originalSource = fs.readFileSync(sourcePath), originalRead = identity.readValidationFile;
    let changed = false;
    const hook = mock.method(identity, 'readValidationFile', function (...args: Parameters<typeof originalRead>) {
        const result = originalRead(...args);
        if (!changed && String(args[1]).endsWith('/result.json')) {
            changed = true;
            fs.appendFileSync(sourcePath, ' ');
        }
        return result;
    });
    try {
        // A typed race: the navigator retries next-step, and the stable inspection below passes.
        assert.throws(() => fixture.inspect(), (error: unknown) => error instanceof ValidationInspectionRaceError
            && /scope|changed|identit/iu.test(error.message));
        assert.equal(changed, true, 'Mutation must occur inside the actual retained-result read.');
        hook.mock.restore();
        fs.writeFileSync(sourcePath, originalSource);
        assertObserved(fixture.inspect());
    } finally { hook.mock.restore(); fixture.cleanup(); }
});

test('recipe inspection rejects a native event appended during retained reads and accepts the next stable inspection', async () => {
    const fixture = await executedFixture(), originalRead = identity.readValidationFile;
    let appended = false;
    const hook = mock.method(identity, 'readValidationFile', function (...args: Parameters<typeof originalRead>) {
        const result = originalRead(...args);
        if (!appended && String(args[1]).endsWith('/result.json')) {
            appended = true;
            appendTaskEvent(fixture.bundle, fixture.taskId, 'PROJECT_VALIDATION_INSPECTION_PROBE', 'INFO',
                'Isolated test appends a real native event during read-only inspection.', {}, { actor: 'gate' });
        }
        return result;
    });
    try {
        assert.throws(() => fixture.inspect(), (error: unknown) => error instanceof ValidationInspectionRaceError
            && error.race === 'timeline' && /timeline|changed/iu.test(error.message));
        assert.equal(appended, true, 'The native event must be appended inside the actual retained-result read.');
        hook.mock.restore();
        assertObserved(fixture.inspect());
    } finally { hook.mock.restore(); fixture.cleanup(); }
});

test('shared evidence handles accept only their live native task and cannot be replayed after inspection', () => {
    const fixture = activationFixture({ prefix: '', packageCwd: false });
    try {
        assert.throws(() => readValidationEvents(fixture.repoRoot, fixture.taskId, 'active', {} as ValidationEvidenceBatch), /inactive|another/iu);
        const handle = withValidationEvidenceBatch({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, recipeIds: ['declared'] }, batch => {
            assert.ok(readValidationEvents(fixture.repoRoot, fixture.taskId, 'active', batch)
                .some(event => event.event_type === 'PREFLIGHT_CLASSIFIED'));
            assert.throws(() => readValidationEvents(fixture.repoRoot, 'T-other', 'active', batch), /another/iu);
            return batch;
        });
        assert.throws(() => readValidationEvents(fixture.repoRoot, fixture.taskId, 'active', handle), /inactive/iu);
    } finally { fixture.cleanup(); }
});

test('docs-only work does not inherit unrelated recipe case obligations', () => {
    const fixture = activationFixture({ prefix: '', packageCwd: false });
    try {
        fs.writeFileSync(path.join(fixture.repoRoot, fixture.source), JSON.stringify({ value: 40 }));
        const docs = 'README.md';
        fs.appendFileSync(path.join(fixture.repoRoot, docs), '\nDocumentation clarification.\n');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, taskIntent: 'Clarify documentation',
            changedFiles: [docs], outputPath: fixture.preflightPath, emitMetrics: false });
        const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        assert.equal(preflight.scope_category, 'docs-only');
        const phases = inspectQualityValidationPhases({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, preflight,
            preflightSha256: createHash('sha256').update(fs.readFileSync(fixture.preflightPath)).digest('hex'),
            matrixRequired: false, matrix: [] });
        assert.deepEqual(phases?.phases.obligations, []);
        assert.deepEqual(phases?.phases.executions, []);
        assert.equal(phases?.phases.execution, 'OBSERVED');
    } finally { fixture.cleanup(); }
});

test('a stable preflight equal to what the recipes froze is not a race: no retry of next-step', async () => {
    const fixture = await executedFixture();
    try {
        const preflightPath = path.resolve(fixture.repoRoot, fixture.preflightPath);
        const frozen = createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex');
        assert.deepEqual(readInspectionFailureFacts(new ValidationInspectionRaceError('Validation quality preflight changed',
            'preflight', frozen), fixture.repoRoot, fixture.taskId, preflightPath), { source: 'inspection', stop: 'preflight-identity' });
        // The file differs from what the recipes froze: a real concurrent rewrite, retried once through next-step.
        const raced = readInspectionFailureFacts(new ValidationInspectionRaceError('Validation quality preflight changed',
            'preflight', '0'.repeat(64)), fixture.repoRoot, fixture.taskId, preflightPath);
        assert.equal(raced.source === 'inspection' && raced.retry, 'next-step');
    } finally { fixture.cleanup(); }
});

test('the inspection retry witness covers recipe and source identity, not only the preflight and timeline', async () => {
    const fixture = await executedFixture(), sourcePath = path.join(fixture.repoRoot, fixture.source);
    try {
        const preflightPath = path.resolve(fixture.repoRoot, fixture.preflightPath);
        const recipeIds = fixture.declaration.recipes.map(recipe => recipe.id);
        const race = () => new ValidationInspectionRaceError('Validation recipe or source identities changed during batch inspection',
            'identities', null, recipeIds);
        const first = readInspectionFailureFacts(race(), fixture.repoRoot, fixture.taskId, preflightPath);
        const token = first.source === 'inspection' ? String(first.retryToken) : '';
        assert.match(token, /^1:[a-f0-9]{64}$/u);
        assert.deepEqual(readInspectionFailureFacts(race(), fixture.repoRoot, fixture.taskId, preflightPath, token),
            { source: 'inspection', stop: 'unchanged', attempts: 1 }, 'unchanged inputs are not retried again');
        // Only a recipe source changed (preflight and timeline bytes are the same): a real change, retried once more.
        fs.appendFileSync(sourcePath, ' ');
        const changed = readInspectionFailureFacts(race(), fixture.repoRoot, fixture.taskId, preflightPath, token);
        assert.match(changed.source === 'inspection' ? String(changed.retryToken) : '', /^2:[a-f0-9]{64}$/u, JSON.stringify(changed));
    } finally { fixture.cleanup(); }
});

test('the phase analysis carries Garda\'s typed authority rejection, so its consumers never read the violation text', async () => {
    const fixture = await executedFixture();
    try {
        const bytes = fs.readFileSync(fixture.preflightPath);
        const preflight = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        const analyze = (value: Record<string, unknown>) => readQualityValidationPhaseAnalysis({ repoRoot: fixture.repoRoot,
            taskId: fixture.taskId, preflight: value, preflightSha256: createHash('sha256').update(bytes).digest('hex') });
        assert.equal(analyze(preflight).authority_issue, undefined, 'no authority rejection, no typed issue');
        // An older frozen binding while an audited admission is current: the typed issue says a refresh binds it.
        const stale = analyze({ ...preflight, project_validation: { authority_sha256: '0'.repeat(64) } });
        assert.equal(stale.status, 'invalid');
        assert.equal(stale.authority_issue, 'readmitted');
        assert.match(stale.violations.join(' '), /Declared validation authority rejected/u);
    } finally { fixture.cleanup(); }
});
