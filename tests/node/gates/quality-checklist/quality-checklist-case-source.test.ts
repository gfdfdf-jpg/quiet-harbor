import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { splitCommandLine } from '../../../../src/core/command-line';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runClassifyChangeCommand, runIntermediateCommandCommand, runLoadRulePackCommand, runQualityChecklistCommand } from '../../../../src/cli/commands/gates';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../../src/core/trust-boundary-analysis';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildQualityChecklistArtifact, materializeQualityChecklistAnswersTemplate, resolveDefaultQualityChecklistArtifactPath, type QualityChecklistArtifact } from '../../../../src/gates/quality-checklist';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue }
    from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { removeTempRepoWithRetry } from '../../cli/commands/gate-test-repo-bootstrap';
import { runCliWithCapturedOutput } from '../../cli/commands/gate-test-cli-capture';
import { formatNextStepText, resolveNextStep } from '../next-step/next-step-test-support';

function fixture(t: TestContext, files: Record<string, string | Buffer>, changedFile: string) {
    const repoRoot = createTempRepo(), taskId = 'T-OP-050';
    t.after(() => removeTempRepoWithRetry(repoRoot));
    const put = (file: string, text: string | Buffer) => {
        const absolute = path.join(repoRoot, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, text);
    };
    for (const [file, text] of Object.entries(files)) put(file, text);
    put('.gitignore', 'TASK.md\ngarda-agent-orchestrator/runtime/\n**/target/\n**/__pycache__/\n.pytest_cache/\n');
    const config = buildDefaultWorkflowConfig();
    config.compile_gate.command = 'node --check src/security/category-authorization.ts';
    put('garda-agent-orchestrator/live/config/workflow-config.json', JSON.stringify(config));
    seedTaskQueue(repoRoot, taskId, 'TODO', 'default', 'Required reviews: code, security, test.', 'Reject unauthorized category changes');
    seedInitAnswers(repoRoot);
    initializeGitRepo(repoRoot);
    const entered = runEnterTaskMode({ repoRoot, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Reject unauthorized category changes', provider: 'Codex' });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, taskId); runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
    const security = 'src/security/category-authorization.ts';
    put(security, 'export const requiresStoredGrant = true;\n');
    fs.appendFileSync(path.join(repoRoot, changedFile), changedFile.endsWith('.py') ? '\n# current test\n' : '\n// current test\n');
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews', taskId + '-preflight.json');
    const classified = runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Reject unauthorized category changes',
        changedFiles: [security, changedFile], outputPath: preflightPath, emitMetrics: false });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    runLoadRulePackCommand({ repoRoot, taskId, stage: 'POST_PREFLIGHT', preflightPath,
        loadedRuleFiles: ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'],
        emitMetrics: false });
    const editable = materializeQualityChecklistAnswersTemplate({ repoRoot, taskId, preflightPath });
    const answersPath = editable.answers_path;
    const template = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
    const selectAnswers = (source: string, caseId: string) => {
        const matrix = [{ boundary_id: 'TB-050', boundary: 'Stored grant to route authority',
            authority_source: security, mutable_inputs: ['request roles'], integrity_evidence: ['stored grants'],
            canonical_reconstruction: 'Load the grant from storage.', toctou_replay: 'Retry using legacy roles.',
            negative_paths: [{ kind: 'other', scenario: 'Missing grant', expected_behavior: 'Reject the request.',
                evidence_files: [source + '#' + caseId] }] }];
        const answers = { ...template, answers: template.answers.map((answer: { rule_id: string }) => ({
            ...answer, status: 'PASS', answer: 'Checked the current boundary.',
            ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix } : {})
        })) };
        return answers;
    };
    return { repoRoot, taskId, answersPath, selectAnswers,
        readArtifact: () => JSON.parse(fs.readFileSync(resolveDefaultQualityChecklistArtifactPath(repoRoot, taskId), 'utf8')) as QualityChecklistArtifact,
        publish: () => runQualityChecklistCommand({ repoRoot, taskId, preflightPath, answersPath, emitMetrics: false }),
        build: (answers: unknown) => buildQualityChecklistArtifact({ repoRoot, taskId, preflightPath, answers }),
        run: (command: string, source: string, case_id: string, selector: string) =>
            runIntermediateCommandCommand({ repoRoot, taskId, preflightPath, command, commandSource: 'targeted-test',
                selectedCases: [{ source, case_id, selector }] }) };
}

function runnerFixture(name: string, argument: string) {
    const executable = process.platform === 'win32' ? `tools/${name}.cmd` : `tools/${name}`;
    return { executable, files: {
        [executable]: process.platform === 'win32' ? '@echo off\nnode tools/runner.cjs %*\n'
            : '#!/bin/sh\nexec node tools/runner.cjs "$@"\n',
        'tools/runner.cjs': `if (!process.argv.includes(${JSON.stringify(argument)})) process.exit(2);\nconsole.log('selected check passed');\n`
    } };
}

function assertCorrection(message: string, source: string, caseId: string, selector: string) {
    assert.ok(message.includes(
        `source ${JSON.stringify(source)}, case ${JSON.stringify(caseId)}, selector ${JSON.stringify(selector)}.`), message);
    assert.match(message, /Cite the file that declares this case in the checklist reference and in --selected-case/u);
    assert.match(message, /identifier as written in that file as case_id .*"test_price"/u);
    assert.match(message, /selector may stay the full runner ID .*"tests\/test_price\.py::test_price\[zero\]"/u);
    return true;
}

async function assertStructuralAndObserved(f: ReturnType<typeof fixture>, command: string, source: string,
    caseId: string, selector: string, wrong: readonly string[]) {
    const pending = f.build(f.selectAnswers(source, caseId)).validation_phases;
    assert.deepEqual([pending?.structural, pending?.execution], ['BOUND', 'PENDING']);
    for (const file of wrong) {
        assert.match(f.build(f.selectAnswers(file, caseId)).violations.join('\n'), /selector unknown/u);
        await assert.rejects(f.run(command, file, caseId, selector),
            (error: Error) => assertCorrection(error.message, file, caseId, selector));
    }
    const succeeded = await f.run(command, source, caseId, selector);
    assert.equal(succeeded.exitCode, 0, succeeded.outputLines.join('\n'));
    for (const file of wrong) {
        const refused = f.build(f.selectAnswers(file, caseId));
        assert.equal(refused.status, 'CONFIG_ERROR');
        assert.deepEqual([refused.validation_phases?.structural, refused.validation_phases?.execution], ['INVALID', 'REJECTED']);
        assertCorrection(refused.violations.join('\n'), file, caseId, selector);
    }
    const observed = f.build(f.selectAnswers(source, caseId)).validation_phases;
    assert.deepEqual([observed?.structural, observed?.execution], ['BOUND', 'OBSERVED'],
        observed?.execution_diagnostics.join('\n'));
}

test('OP-050 Maven-shaped selector refuses unrelated test and production sources and accepts an inherited case', async t => {
    const base = 'backend/application/src/test/java/example/BasePermissionTest.java';
    const child = 'backend/application/src/test/java/example/CatalogPermissionIntegrationTest.java';
    const other = 'backend/application/src/test/java/example/ProductPublicationPostgresIntegrationTest.java';
    const production = 'backend/catalog/src/main/java/example/CategoryRepository.java';
    const caseId = 'everyRouteDeniesLegacyRolesWithoutStoredGrants';
    const selector = 'CatalogPermissionIntegrationTest#' + caseId;
    const runner = runnerFixture('mvnw', '-Dtest=' + selector);
    const f = fixture(t, { ...runner.files,
        [base]: 'class BasePermissionTest { @org.junit.jupiter.api.Test void ' + caseId + '() {} }\n',
        [child]: 'class CatalogPermissionIntegrationTest extends BasePermissionTest {}\n',
        [other]: 'class ProductPublicationPostgresIntegrationTest {}\n',
        [production]: 'class CategoryRepository {}\n',
        'backend/pom.xml': '<project/>\n'
    }, base);
    if (process.platform !== 'win32') fs.chmodSync(path.join(f.repoRoot, runner.executable), 0o755);
    await assertStructuralAndObserved(f, runner.executable + ' -f backend/pom.xml -pl application -am test -Dtest=' + selector,
        base, caseId, selector, [other, production, child]);
});

test('OP-050 pytest node ID refuses the wrong file and accepts the cited case', async t => {
    const selected = 'tests/test_permissions.py', source = 'tests/base_permissions.py', wrong = 'tests/test_products.py';
    const caseId = 'test_denied', selector = selected + '::TestPermission::' + caseId;
    const runner = runnerFixture('pytest', selector);
    const f = fixture(t, { ...runner.files,
        [source]: 'class BasePermissions:\n    def test_denied(self):\n        assert True\n',
        [selected]: 'from base_permissions import BasePermissions\n\nclass TestPermission(BasePermissions):\n    pass\n',
        [wrong]: 'def test_denied_detail():\n    assert True\n' }, selected);
    if (process.platform !== 'win32') fs.chmodSync(path.join(f.repoRoot, runner.executable), 0o755);
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const native = spawnSync(python, ['-m', 'pytest', '--version'], { windowsHide: true }).status === 0;
    if (!native) t.diagnostic('pytest unavailable, using a literal selector fixture');
    await assertStructuralAndObserved(f, (native ? python + ' -B -m pytest -p no:cacheprovider' : runner.executable) + ' ' + selector,
        source, caseId, selector, [wrong, selected]);
});

test('OP-050 Go selector refuses a nonmatching identifier and accepts the focused case', async t => {
    const source = 'policy/auth_test.go', wrong = 'policy/categories.go', caseId = 'TestDenied';
    const runner = runnerFixture('go', '-run=' + caseId);
    const f = fixture(t, { ...runner.files, 'go.mod': 'module example.com/permissions\n\ngo 1.20\n',
        [source]: 'package policy\nimport "testing"\nfunc TestDenied(t *testing.T) {}\n',
        [wrong]: 'package policy\nconst xTestDenied = false\n' }, source);
    if (process.platform !== 'win32') fs.chmodSync(path.join(f.repoRoot, runner.executable), 0o755);
    const native = spawnSync('go', ['version'], { windowsHide: true }).status === 0;
    if (!native) t.diagnostic('Go unavailable, using a literal selector fixture');
    await assertStructuralAndObserved(f, (native ? 'go' : runner.executable) + ' test ./policy -run=' + caseId,
        source, caseId, caseId, [wrong]);
});

test('OP-050 pytest accepts a source identifier with the full parametrized selector', async t => {
    const source = 'tests/test_price.py', wrong = 'tests/test_discount.py';
    const caseId = 'test_price', selector = source + '::test_price[zero]';
    const runner = runnerFixture('pytest', selector);
    const f = fixture(t, { ...runner.files,
        [source]: 'import pytest\n\n@pytest.mark.parametrize("amount", [0], ids=["zero"])\n'
            + 'def test_price(amount):\n    assert amount == 0\n',
        [wrong]: 'def test_price_adjusted():\n    assert True\n' }, source);
    if (process.platform !== 'win32') fs.chmodSync(path.join(f.repoRoot, runner.executable), 0o755);
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const native = spawnSync(python, ['-m', 'pytest', '--version'], { windowsHide: true }).status === 0;
    if (!native) t.diagnostic('pytest unavailable, using a literal selector fixture');
    const command = (native ? python + ' -B -m pytest -p no:cacheprovider' : runner.executable) + ' "' + selector + '"';
    await assert.rejects(f.run(command, source, 'test_price[zero]', selector),
        (error: Error) => assertCorrection(error.message, source, 'test_price[zero]', selector));
    await assertStructuralAndObserved(f, command, source, caseId, selector, [wrong]);
});

test('OP-050 UTF-16 C# sources bind in both capture paths with the original byte hash', async t => {
    const stub = 'tools/check.cjs', little = 'tests/Price.LittleEndian.cs', big = 'tests/Price.BigEndian.cs';
    const wrong = 'tests/OtherPrices.cs';
    const caseId = 'Denied', selector = 'PriceTests.Denied';
    const text = 'class PriceTests { void Denied() {} }\n';
    const f = fixture(t, {
        [stub]: '// Simulated focused command\n',
        [little]: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
        [big]: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
        [wrong]: 'class OtherPrices { void DeniedÉ() {} }\n'
    }, stub);
    const command = 'node ' + stub + ' ' + selector;
    await assertStructuralAndObserved(f, command, little, caseId, selector, [wrong]);
    const succeeded = await f.run(command, big, caseId, selector);
    assert.equal(succeeded.exitCode, 0, succeeded.outputLines.join('\n'));
    const phases = f.build(f.selectAnswers(big, caseId)).validation_phases;
    assert.deepEqual([phases?.structural, phases?.execution], ['BOUND', 'OBSERVED'], phases?.execution_diagnostics.join('\n'));
    for (const source of [little, big]) {
        const identity = f.build(f.selectAnswers(source, caseId)).validation_phases?.obligations[0]?.source_identity;
        assert.equal(identity?.sha256, validationDigest(fs.readFileSync(path.join(f.repoRoot, source))));
    }
});

test('OP-050 nested Node test using a shared assertion helper is structurally bound and observed', async t => {
    const source = 'tests/catalog-permission.test.cjs', wrong = 'tests/product-publication.test.cjs';
    const caseId = 'rejects an expired token';
    const f = fixture(t, {
        [source]: "const { describe, it } = require('node:test');\nconst deny = require('./assert-denied.cjs');\n"
            + "describe('permissions', () => { it('rejects an expired token', deny); });\n",
        [wrong]: '// Rejects an expired token $rejects an expired token rejects an expired token2 rejects an expired token_\n',
        'tests/assert-denied.cjs': "module.exports = () => require('node:assert/strict').equal(false, false);\n"
    }, source);
    const nodeTestContext = process.env.NODE_TEST_CONTEXT;
    try {
        delete process.env.NODE_TEST_CONTEXT;
        await assertStructuralAndObserved(f, 'node --test ' + source, source, caseId, source, [wrong]);
    } finally {
        if (nodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = nodeTestContext;
    }
});

test('OP-050 rejects lone surrogates and blank case IDs with the two-field correction', async t => {
    const source = 'tests/permissions.cjs', selector = 'permissions';
    const f = fixture(t, { [source]: 'function 𐐀() {}\n' }, source);
    for (const caseId of ['\ud801', '\udc00', '', ' \t ']) {
        await assert.rejects(f.run('node ' + source + ' ' + selector, source, caseId, selector),
            (error: Error) => assertCorrection(error.message, source, caseId, selector));
        const artifact = f.build(f.selectAnswers(source, caseId));
        assert.equal(artifact.status, 'CONFIG_ERROR');
        const message = artifact.violations.join('\n');
        assert.ok(message.includes(`source "${source}", case ${JSON.stringify(caseId.trim())}, selector unknown.`), message);
        assert.match(message, /identifier as written in that file as case_id/u);
        assert.match(message, /selector may stay the full runner ID/u);
    }
});

test('OP-050 resubmits a base-accepted pending checklist after an installed task upgrades', async t => {
    const source = 'tests/permissions.cjs', wrong = 'tests/products.cjs';
    const caseId = 'rejectsUnauthorized', selector = 'Suite.rejectsUnauthorized[no grant]';
    const f = fixture(t, { [source]: 'function rejectsUnauthorized() {}\n', [wrong]: '// Product checks\n' }, source);
    const wrongAnswers = f.selectAnswers(wrong, selector);
    fs.writeFileSync(f.answersPath, JSON.stringify(wrongAnswers));
    const boundarySources = require('../../../../src/core/trust-boundary-source-evidence') as
        typeof import('../../../../src/core/trust-boundary-source-evidence');
    // Before OP-050, the gate bound each exact file identity without requiring the case token.
    // Publish through the real gate so the legacy-shaped artifact and timeline entry agree.
    const legacyRead = t.mock.method(boundarySources, 'readBoundarySourceEvidence',
        (options: Parameters<typeof boundarySources.readBoundarySourceEvidence>[0]) => {
            const { sources, violations } = boundarySources.readBoundarySources(options);
            return { violations, sourceEvidence: options.references.map(({ filePath, caseId }) => ({
                source_identity: sources.get(filePath)!.identity, case_id: caseId,
                selector: caseId, syntax_status: 'UNRESOLVED' as const
            })) };
        });
    try {
        const published = f.publish();
        assert.equal(published.exitCode, 0, published.outputLines.join('\n'));
        const artifact = f.readArtifact();
        assert.equal(artifact.status, 'PENDING_VALIDATION');
        assert.equal(artifact.validation_phases?.obligations[0]?.source_identity.path, wrong);
        assert.equal(artifact.validation_phases?.obligations[0]?.target_id, selector);
    } finally { legacyRead.mock.restore(); }

    const navigation = () => resolveNextStep({ repoRoot: f.repoRoot, taskId: f.taskId });
    const rejected = navigation();
    assert.equal(rejected.next_gate, 'quality-checklist', rejected.reason);
    assert.equal(rejected.quality_checklist?.status, 'PENDING_VALIDATION');
    assert.equal(rejected.commands.length, 0);
    assert.match(rejected.reason, /Cite the file that declares this case/u);
    assert.match(rejected.reason, /identifier as written in that file as case_id/u);
    assert.match(rejected.reason, /resubmit through quality-checklist/u);
    assert.doesNotMatch(formatNextStepText(rejected), /retry recipe evidence/u);

    fs.writeFileSync(f.answersPath, JSON.stringify(f.selectAnswers(source, caseId)));
    const corrected = navigation();
    assert.equal(corrected.next_gate, 'quality-checklist', corrected.reason);
    assert.equal(corrected.commands.length, 1);
    const command = corrected.commands[0].command;
    assert.match(command, /gate quality-checklist.*--answers-path/u);
    const argv = splitCommandLine(command.slice(command.indexOf('gate quality-checklist')));
    const resubmitted = await runCliWithCapturedOutput(argv, { cwd: f.repoRoot });
    assert.equal(resubmitted.exitCode, 0, [...resubmitted.logs, ...resubmitted.errors].join('\n'));
    const pending = navigation();
    assert.equal(pending.next_gate, 'run-intermediate-command', pending.reason);
    const recorded = await f.run(`node ${source} "${selector}"`, source, caseId, selector);
    assert.equal(recorded.exitCode, 0, recorded.outputLines.join('\n'));
    const refreshed = f.publish();
    assert.equal(refreshed.exitCode, 0, refreshed.outputLines.join('\n'));
    const phases = f.readArtifact().validation_phases!;
    assert.deepEqual([phases.structural, phases.execution], ['BOUND', 'OBSERVED']);
    assert.deepEqual(phases.obligations.map(item => [item.source_identity.path, item.target_id]), [[source, caseId]]);
    const advanced = navigation();
    assert.equal(advanced.next_gate, 'compile-gate', advanced.reason);
});
