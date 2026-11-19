import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { TaskValidationDeclaration } from '../../../../src/core/task-validation-plan';

/** Project facts belong to the fixture, never to the native navigator or gate implementations. */
export interface WalkFixtureDescriptor {
    id: string;
    files: Record<string, string>;
    executableFiles?: string[];
    compileCommand: string;
    /** Unknown-stack tours keep global compile unset and fill the task-local navigator placeholder. */
    configuredCompileCommand?: string;
    projectTestCommand: string;
    taskTestCommand: string;
    /** Agent-owned declarations, separate from the broad project reference. */
    taskTestInvocations?: Array<{ command: string; targets: string[] }>;
    taskTestSupport?: TaskValidationDeclaration['support'];
    primarySource: string;
    primaryTest: string;
    taskTitle: string;
    selectionReason?: string;
    caseReasoning?: string;
    caseCommand: string;
    cases: Array<{ source: string; case_id: string; selector: string }>;
    trustBoundaryMatrix: unknown[];
    inspectReviewEvidence?: (root: string, taskId: string, lane: string) => string[] | void;
    /** Resolve retained execution using this fixture's source/output contract. */
    passedCaseQuote: (root: string, source: string, selector: string, output: string) => string | undefined;
    failedCaseQuote?: (root: string, source: string, selector: string, output: string) => string | undefined;
}

export function seedWalkFixture(root: string, fixture: WalkFixtureDescriptor): void {
    for (const [relative, content] of Object.entries(fixture.files)) {
        const file = path.join(root, relative);
        if (path.relative(root, file).startsWith('..') || path.isAbsolute(relative)) throw new Error('Escaping fixture file: ' + relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const installedIgnore = relative === '.gitignore' && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        fs.writeFileSync(file, installedIgnore + content, 'utf8');
    }
    for (const file of fixture.executableFiles ?? []) fs.chmodSync(path.join(root, file), 0o755);
}

/** A gate-tour may share a project ID while changing installed commands or layout. */
export function walkFixtureTemplateKey(fixture: WalkFixtureDescriptor): string {
    return createHash('sha256').update(JSON.stringify({ id: fixture.id, files: fixture.files,
        executableFiles: fixture.executableFiles, compile: fixture.compileCommand, configuredCompile: fixture.configuredCompileCommand, tests: fixture.projectTestCommand,
        taskTests: fixture.taskTestInvocations, taskTestCommand: fixture.taskTestCommand, taskTestSupport: fixture.taskTestSupport,
        title: fixture.taskTitle })).digest('hex');
}

export const COMPILE_FAILURE_FLAG = '.git/walk-fail-compile';
export const FULL_SUITE_FAILURE_FLAG = '.git/walk-fail-full-suite';

function failingOnceScript(flag: string, label: string): string {
    return [
        'const fs = require("node:fs");',
        'if (fs.existsSync("' + flag + '")) {',
        '    fs.rmSync("' + flag + '");',
        '    console.error("' + label + ' failed");',
        '    process.exit(1);',
        '}',
        'console.log("' + label + ' ok");',
        ''
    ].join('\n');
}

const CASE = 'rejects replaced session evidence';
const TEST = 'tests/auth.test.cjs';

/** Byte-for-byte legacy project: old scenarios keep their commands, timing and review oracle. */
export const NODE_WALK_FIXTURE: WalkFixtureDescriptor = {
    id: 'legacy-node',
    compileCommand: 'node scripts/build-check.cjs',
    projectTestCommand: 'node scripts/full-suite-check.cjs',
    taskTestCommand: 'node scripts/full-suite-check.cjs',
    primarySource: 'src/app.ts', primaryTest: 'tests/app.test.ts', taskTitle: 'Change the status renderer',
    selectionReason: 'the status renderer changes and task acceptance criteria',
    caseReasoning: 'The actual retained Node test output marks this selected temporary case as passed.',
    caseCommand: 'node --test --test-name-pattern="' + CASE + '" ' + TEST,
    cases: [{ source: TEST, case_id: CASE, selector: CASE }],
    trustBoundaryMatrix: [{
        boundary_id: 'TB-WALK-001', boundary: 'Synthetic session token to the status renderer',
        authority_source: 'The session file in the task diff', mutable_inputs: ['session token'],
        integrity_evidence: ['session sha256'], canonical_reconstruction: 'Rebuild the session from the current source file.',
        toctou_replay: 'Reject a stale or replaced session.', negative_paths: [{ kind: 'replaced', scenario: CASE,
            expected_behavior: 'Reject the replaced session.', evidence_files: [TEST + '#' + CASE] }]
    }],
    files: {
        [TEST]: ['const assert = require("node:assert/strict");', 'const test = require("node:test");', '',
            'test("' + CASE + '", () => {', '    assert.equal(true, true);', '});', ''].join('\n'),
        'package.json': JSON.stringify({ name: 'walk-fixture', private: true }, null, 2) + '\n',
        'docs/guide.md': '# Guide\n',
        'src/app.ts': 'export function renderStatus() {\n    return "ready";\n}\n',
        'tests/app.test.ts': 'import test from "node:test";\n\ntest("status", () => undefined);\n',
        'scripts/build-check.cjs': failingOnceScript(COMPILE_FAILURE_FLAG, 'build'),
        'scripts/full-suite-check.cjs': failingOnceScript(FULL_SUITE_FAILURE_FLAG, 'full suite')
    },
    passedCaseQuote: (_root, _source, selector, output) => output.split(/\r?\n/u).find(line =>
        line.includes(selector) && /^(?:ok \d+ -|✔)/u.test(line.trim()))
};
