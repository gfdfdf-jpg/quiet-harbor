import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import { runContractMigrations } from '../../../src/lifecycle/contract-migrations';
import { runUpdate } from '../../../src/lifecycle/update';
import { planManualValidationSelector } from '../../../src/materialization/manual-validation-selector-migration';
import { runReinit } from '../../../src/materialization/reinit';
import { refreshMixedRule } from '../../../src/materialization/rule-refresh';
import { readMarkedRuleSections } from '../../../src/materialization/rule-sections';
import { detectTaskModeRuleContractViolations, formatVerifyResult, runVerify } from '../../../src/validators/verify';
import { TEST_COMPILE_GATE_COMMAND, writeTestCompileFixture } from '../cli/commands/gate-test-repo-bootstrap';

function findRoot(): string {
    let current = __dirname;
    while (!fs.existsSync(path.join(current, 'template'))) {
        const parent = path.dirname(current);
        if (parent === current) throw new Error('Repository root unavailable');
        current = parent;
    }
    return current;
}
const root = findRoot();
const selectorHeading = '### Manual Validation Evidence Selector';
const anchorHeading = '## Project Commands (Required)';
const startMarker = '<!-- garda:rule-section:manual-validation-evidence-selector:start -->';
const endMarker = '<!-- garda:rule-section:manual-validation-evidence-selector:end -->';

function workspace(t: TestContext) {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-r3-commands-'));
    t.after(() => fs.rmSync(targetRoot, { recursive: true, force: true }));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(bundleRoot);
    for (const file of ['VERSION', 'package.json', 'MANIFEST.md', '.gitattributes', 'AGENT_INIT_PROMPT.md', 'HOW_TO.md']) {
        fs.copyFileSync(path.join(root, file), path.join(bundleRoot, file));
    }
    for (const dir of ['template', 'bin']) fs.cpSync(path.join(root, dir), path.join(bundleRoot, dir), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'dist/src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'dist/src/index.js'), 'module.exports = {};');
    for (const dir of ['cli', 'gates', 'lifecycle', 'materialization', 'validators']) {
        fs.mkdirSync(path.join(bundleRoot, 'dist/src', dir));
    }
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, '.git/hooks'), { recursive: true });
    const initAnswersPath = path.join(bundleRoot, 'runtime/init-answers.json');
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false', ClaudeOrchestratorFullAccess: 'false', TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    }));
    writeTestCompileFixture(targetRoot);
    const config = path.join(bundleRoot, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ compile_gate: { command: TEST_COMPILE_GATE_COMMAND } }));
    runUpdate({ targetRoot, bundleRoot, initAnswersPath, skipVerify: true, skipManifestValidation: true });
    const commands = path.join(bundleRoot, 'live/docs/agent-rules/40-commands.md');
    const installed = fs.readFileSync(commands, 'utf8');
    const liveVersionPath = path.join(bundleRoot, 'live/version.json');
    const liveVersion = JSON.parse(fs.readFileSync(liveVersionPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(liveVersionPath, JSON.stringify({ ...liveVersion, Version: '1.4.3' }));
    // Historical input is the published v1.4.3 template, before managed section markers existed.
    const historical = fs.readFileSync(path.join(root, 'tests/node/fixtures/fix-c-v1.4.3-40-commands.md'), 'utf8');
    fs.writeFileSync(commands, historical);
    return { targetRoot, bundleRoot, initAnswersPath, commands, historical, installed };
}

function update(w: ReturnType<typeof workspace>) {
    return runUpdate({
        ...w, skipManifestValidation: true, contractMigrationRunner: runContractMigrations,
        verifyRunner: options => {
            const result = runVerify(options);
            if (!result.passed) throw new Error(formatVerifyResult(result));
        }
    });
}

function assertBackup(w: ReturnType<typeof workspace>, reportPath: string, original: Buffer): void {
    const report = fs.readFileSync(path.join(w.targetRoot, reportPath), 'utf8');
    const match = /`([^`]*-replaced-rules\/40-commands\.md)`/u.exec(report);
    assert.ok(match, 'update report must identify the prior commands file');
    assert.deepEqual(fs.readFileSync(path.join(w.targetRoot, match[1])), original);
    assert.equal(path.dirname(path.dirname(path.join(w.targetRoot, match[1]))), path.dirname(path.join(w.targetRoot, reportPath)));
}

const currentSelectorRequirement = 'root `task_id` matching the current task';
const staleSelectorRequirement = 'the previous selector identity contract';

function outsideMarkedSections(content: string): string {
    const sections = readMarkedRuleSections(content);
    assert.ok(sections);
    let outside = '';
    let offset = 0;
    for (const section of sections) {
        outside += content.slice(offset, section.index);
        offset = section.index + section.raw.length;
    }
    return outside + content.slice(offset);
}

function assertRefreshedSelector(before: string, after: string, current: string): void {
    assert.equal(outsideMarkedSections(after), outsideMarkedSections(before));
    const live = readMarkedRuleSections(after)?.find(section => section.id === 'manual-validation-evidence-selector');
    const template = readMarkedRuleSections(current)?.find(section => section.id === 'manual-validation-evidence-selector');
    assert.ok(live && template);
    assert.equal(live.raw, template.raw);
}

test('update refreshes an outdated marked selector and backs up unchanged outside bytes', t => {
    const w = workspace(t);
    const outside = '\r\n## Operator runbook\r\nKeep 日本語, $& and trailing spaces.  \r\n';
    const expected = outside + w.installed.replace(startMarker, () => outside + startMarker) + outside;
    const before = Buffer.from(expected.replace(currentSelectorRequirement, staleSelectorRequirement));
    assert.notEqual(before.toString('utf8'), expected);
    fs.writeFileSync(w.commands, before);

    const result = update(w);
    assert.equal(result.verifyStatus, 'PASS');
    assertRefreshedSelector(before.toString('utf8'), fs.readFileSync(w.commands, 'utf8'), w.installed);
    assertBackup(w, result.updateReportPath, before);
});

test('reinit repairs an outdated marked selector and backs up its prior bytes', t => {
    const w = workspace(t);
    const before = Buffer.from(w.installed.replace(currentSelectorRequirement, staleSelectorRequirement));
    fs.writeFileSync(w.commands, before);
    const reports = path.join(w.bundleRoot, 'runtime/update-reports');
    const beforeReports = new Set(fs.readdirSync(reports));

    runReinit({ ...w, skipVerify: true, skipManifestValidation: true });
    assertRefreshedSelector(before.toString('utf8'), fs.readFileSync(w.commands, 'utf8'), w.installed);
    const report = fs.readdirSync(reports).find(name => name.startsWith('rule-refresh-') && name.endsWith('.md') && !beforeReports.has(name));
    assert.ok(report);
    assertBackup(w, path.relative(w.targetRoot, path.join(reports, report)), before);
});

test('refresh updates a marked selector inside an otherwise unmarked customized file', () => {
    const template = fs.readFileSync(path.join(root, 'template/docs/agent-rules/40-commands.md'), 'utf8');
    const historical = fs.readFileSync(path.join(root, 'tests/node/fixtures/fix-c-v1.4.3-40-commands.md'), 'utf8');
    const operator = '### Skill Packs\nOperator commands: 日本語, $& and `literal`  \r\n';
    const original = historical.replace('### Skill Packs\n', () => operator);
    const inserted = refreshMixedRule(Buffer.from(original), template, '40-commands.md');
    assert.equal(inserted.warning, null);
    const stale = inserted.content.replace(currentSelectorRequirement, staleSelectorRequirement);
    assert.notEqual(stale, inserted.content);

    const refreshed = refreshMixedRule(Buffer.from(stale), template, '40-commands.md');
    assert.equal(refreshed.warning, null);
    assert.equal(refreshed.content, inserted.content);
    assert.ok(refreshed.content.includes(operator));
});

test('a marked file without the selector or insertion heading uses managed refresh', () => {
    const template = fs.readFileSync(path.join(root, 'template/docs/agent-rules/40-commands.md'), 'utf8');
    const marked = template
        .replace(/^<!-- garda:rule-section:manual-validation-evidence-selector:start -->\r?\n[\s\S]*?^<!-- garda:rule-section:manual-validation-evidence-selector:end -->\r?\n/mu, '')
        .replace(anchorHeading, '## Older project commands');
    const operator = '\r\n## Operator notes\r\nKeep 日本語 and $&.  \r\n';
    const before = operator + marked + operator;

    assert.equal(planManualValidationSelector(Buffer.from(before), template).status, 'not-needed');
    const refreshed = refreshMixedRule(Buffer.from(before), template, '40-commands.md');
    assert.equal(refreshed.warning, null);
    assert.ok(refreshed.content.includes(anchorHeading));
    assert.equal(refreshed.content.split(operator).length - 1, 2);
    const selector = readMarkedRuleSections(refreshed.content)?.find(section => section.id === 'manual-validation-evidence-selector');
    assert.ok(selector?.body.includes(currentSelectorRequirement));
});

test('1.4.3 update preserves a large operator block byte for byte, backs up the file and passes real VERIFY', t => {
    const w = workspace(t);
    const operatorBlock = '```bash\r\n# Project commands: 日本語, $& and `literal`  \r\n'
        + 'project action --flag="keep  spaces"\r\n'.repeat(16000) + '```\r\n';
    const before = Buffer.from(w.historical.replace('### Skill Packs\n', () => '### Skill Packs\n' + operatorBlock));
    assert.ok(before.length > 500_000);
    assert.ok(before.includes(Buffer.from(operatorBlock)));
    fs.writeFileSync(w.commands, before);
    assert.ok(detectTaskModeRuleContractViolations(w.targetRoot).some(item => item.includes('root `task_id` matching the current task')));
    const originalVerify = runVerify({ targetRoot: w.targetRoot, initAnswersPath: w.initAnswersPath, sourceOfTruth: 'Claude' });
    assert.equal(originalVerify.passed, false);
    assert.ok(originalVerify.violations.ruleFileViolations.some(item => item.includes('root `task_id` matching the current task')));

    const result = update(w);
    assert.equal(result.verifyStatus, 'PASS');
    assert.equal(result.previousVersion, '1.4.3');
    assert.equal(result.updatedVersion, '1.4.4');
    const after = fs.readFileSync(w.commands, 'utf8');
    assert.ok(after.includes(operatorBlock));
    const template = fs.readFileSync(path.join(w.bundleRoot, 'template/docs/agent-rules/40-commands.md'), 'utf8');
    const section = template.slice(template.indexOf(startMarker), template.indexOf(endMarker) + endMarker.length + 1);
    assert.ok(after.includes(section), 'the inserted managed section must match the shipped template');
    assert.deepEqual(Buffer.from(after.replace(section, '')), before, 'no other original bytes may change');
    assertBackup(w, result.updateReportPath, before);
    assert.equal(detectTaskModeRuleContractViolations(w.targetRoot).some(item => item.includes('root `task_id` matching the current task')), false);
});

test('an unedited 1.4.3 commands file migrates with a backup and passes real VERIFY', t => {
    const w = workspace(t);
    const before = fs.readFileSync(w.commands);
    const result = update(w);
    assert.equal(result.verifyStatus, 'PASS');
    assert.equal(result.previousVersion, '1.4.3');
    const after = fs.readFileSync(w.commands, 'utf8');
    assert.ok(after.includes(selectorHeading));
    assert.ok(after.includes('<!-- garda:rule-section:skill-packs:start -->'));
    assertBackup(w, result.updateReportPath, before);
});

test('standalone contract migration backs up and preserves the edited 1.4.3 file', t => {
    const w = workspace(t);
    const operator = '```bash\r\nproject command "$&"\r\n```\r\n';
    const original = Buffer.from(w.historical.replace('### Skill Packs\n', () => '### Skill Packs\n' + operator));
    fs.writeFileSync(w.commands, original);
    const reports = path.join(w.bundleRoot, 'runtime/update-reports');
    const beforeReports = new Set(fs.readdirSync(reports));
    const result = runContractMigrations({ rootPath: w.targetRoot });
    assert.ok(result.appliedFiles.includes('garda-agent-orchestrator/live/docs/agent-rules/40-commands.md'));
    const report = fs.readdirSync(reports).find(name => name.startsWith('rule-refresh-') && !beforeReports.has(name));
    assert.ok(report);
    assertBackup(w, path.relative(w.targetRoot, path.join(reports, report)), original);
    assert.ok(fs.readFileSync(w.commands, 'utf8').includes(operator));
    assert.equal(detectTaskModeRuleContractViolations(w.targetRoot).some(item => item.includes('root `task_id` matching the current task')), false);
});

test('a missing insertion point stops direct update before install or snapshot', t => {
    const w = workspace(t);
    const broken = Buffer.from(w.historical.replace(anchorHeading, '## Operator renamed this heading'));
    fs.writeFileSync(w.commands, broken);
    const snapshots = path.join(w.bundleRoot, 'runtime/update-rollbacks');
    const before = fs.readdirSync(snapshots);
    let applied = false;
    assert.throws(() => runUpdate({
        ...w, skipVerify: true, skipManifestValidation: true,
        installRunner: () => { applied = true; }
    }), /40-commands\.md[\s\S]*Manual Validation Evidence Selector[\s\S]*Project Commands \(Required\)/u);
    assert.equal(applied, false);
    assert.deepEqual(fs.readFileSync(w.commands), broken);
    assert.deepEqual(fs.readdirSync(snapshots), before);
});

test('a missing insertion point stops bundle sync before applying an available update', async t => {
    const w = workspace(t);
    const broken = Buffer.from(w.historical.replace(anchorHeading, '## Operator renamed this heading'));
    fs.writeFileSync(w.commands, broken);
    const source = path.join(w.targetRoot, 'update-source');
    fs.cpSync(w.bundleRoot, source, { recursive: true });
    fs.writeFileSync(path.join(source, 'VERSION'), '9.9.9\n');
    fs.writeFileSync(path.join(source, 'README.md'), 'new source marker\n');
    const version = fs.readFileSync(path.join(w.bundleRoot, 'VERSION'));
    let applied = false;
    await assert.rejects(() => runCheckUpdate({
        targetRoot: w.targetRoot, bundleRoot: w.bundleRoot, sourcePath: source,
        apply: true, noPrompt: true, trustOverride: true,
        updateRunner: () => { applied = true; }
    }), /40-commands\.md[\s\S]*Manual Validation Evidence Selector[\s\S]*Project Commands \(Required\)/u);
    assert.equal(applied, false);
    assert.deepEqual(fs.readFileSync(w.commands), broken);
    assert.deepEqual(fs.readFileSync(path.join(w.bundleRoot, 'VERSION')), version);
    assert.equal(fs.existsSync(path.join(w.bundleRoot, 'README.md')), false);
    assert.equal(fs.existsSync(path.join(w.bundleRoot, 'runtime/bundle-backups')), false);
});

test('inline and marked operator edits survive repeated refreshes without duplicating old sections', () => {
    const template = fs.readFileSync(path.join(root, 'template/docs/agent-rules/40-commands.md'), 'utf8');
    const historical = fs.readFileSync(path.join(root, 'tests/node/fixtures/fix-c-v1.4.3-40-commands.md'), 'utf8');
    const marked = template.replace(/^<!-- garda:rule-section:manual-validation-evidence-selector:start -->\r?\n[\s\S]*?^<!-- garda:rule-section:manual-validation-evidence-selector:end -->\r?\n/mu, '');
    const operator = '\r\nOperator text: $& and `literal`  \r\n' + 'local command --keep  spaces\r\n'.repeat(1000);
    const section = template.slice(template.indexOf(startMarker), template.indexOf(endMarker) + endMarker.length + 1);
    for (const [original, heading, isMarked] of [[historical, '### Skill Packs', false], [marked, '### Skill Packs', true],
        [historical, '### Manual Validation Logs', false]] as const) {
        const before = original.replace(heading + '\n', () => heading + '\n' + operator);
        const first = refreshMixedRule(Buffer.from(before), template, '40-commands.md');
        assert.equal(first.warning, null);
        assert.ok(first.content.includes(operator));
        assert.equal(first.content.replace(section, ''), before);
        if (isMarked) {
            assert.ok(readMarkedRuleSections(first.content), 'selector insertion must not nest ownership markers');
            assert.ok(first.content.indexOf(startMarker) < first.content.indexOf('<!-- garda:rule-section:project-commands-required:start -->'));
        }
        const again = refreshMixedRule(Buffer.from(first.content), template, '40-commands.md');
        assert.equal(again.content, first.content);
        if (isMarked) assert.equal(again.warning, null);
        else assert.match(again.warning || '', /unmarked Skill Packs section/u);
    }
});

test('selector planning rejects ambiguous, incomplete and invalid inputs while ignoring fenced decoy headings', () => {
    const template = fs.readFileSync(path.join(root, 'template/docs/agent-rules/40-commands.md'), 'utf8');
    const historical = fs.readFileSync(path.join(root, 'tests/node/fixtures/fix-c-v1.4.3-40-commands.md'), 'utf8');
    const decoy = historical.replace(anchorHeading, () => '```text\n' + anchorHeading + '\n```\n\n' + anchorHeading);
    assert.equal(planManualValidationSelector(Buffer.from(decoy), template).status, 'insert');
    assert.equal(planManualValidationSelector(Buffer.from(historical.replace(anchorHeading, anchorHeading + '\n' + anchorHeading)), template).status, 'blocked');
    assert.equal(planManualValidationSelector(Buffer.from(historical.replace(anchorHeading, selectorHeading + '\nincomplete\n\n' + anchorHeading)), template).status, 'blocked');
    assert.equal(planManualValidationSelector(Buffer.concat([Buffer.from(historical), Buffer.from([0xff])]), template).status, 'blocked');
});
