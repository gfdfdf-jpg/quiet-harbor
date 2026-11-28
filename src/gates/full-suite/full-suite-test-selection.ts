import * as path from 'node:path';
import * as fs from 'node:fs';
import { parseCommandChain } from '../../core/command-line';
import { getClassificationConfig } from '../preflight/classify-change-config';
import { isTestScopePath, createTaskTestScopeMatcher } from '../../core/file-role-bindings';
import { createInvocationReadMemoKey, memoizeInvocationRead, registerInvocationDependency } from '../../core/invocation-read-observation';

const CHANGED_TEST_PATHS = createInvocationReadMemoKey<readonly string[]>('changed-test-paths');

function isExistingDirectory(repoRoot: string, value: string): boolean {
    try { return fs.statSync(path.resolve(repoRoot, value)).isDirectory(); } catch { return false; }
}

export function getChangedTestPaths(repoRoot: string, changedFiles: readonly string[], declaredTests: readonly string[] = [],
    supportPaths: readonly string[] = []): readonly string[] {
    const files = changedFiles.map(file => file.replace(/\\/gu, '/'));
    return memoizeInvocationRead(CHANGED_TEST_PATHS, JSON.stringify([path.resolve(repoRoot), files, declaredTests, supportPaths]), () => {
        const classification = getClassificationConfig(repoRoot);
        const isTaskTest = createTaskTestScopeMatcher(classification.test_trigger_regexes, classification.file_roles, declaredTests, supportPaths);
        const probed = files.filter(file => isTaskTest(file)).map(file => ({ file, exists: fs.existsSync(path.resolve(repoRoot, file)) }));
        // The memoized answer is reused for the whole invocation: a test created or deleted meanwhile must fail the
        // invocation before effects and at exit instead of planning with a stale existence answer.
        registerInvocationDependency(probed, () => {
            const changed = probed.find(entry => fs.existsSync(path.resolve(repoRoot, entry.file)) !== entry.exists);
            if (changed) throw new Error(`Changed test existence changed during invocation: ${changed.file}`);
        });
        return Object.freeze(probed.filter(entry => entry.exists).map(entry => entry.file));
    }).value;
}

/** Legacy adapter observations. New task plans use the generic association contract.
 * These observations may be shown to review, never substituted for process identity or semantics.
 */
export function getExcludedChangedTests(repoRoot: string, command: string, changedFiles: readonly string[]): string[] {
    return getExcludedTestPaths(repoRoot, command, getChangedTestPaths(repoRoot, changedFiles));
}

/** Reuse an invocation's already classified, existing test paths without probing them again. */
export function getExcludedTestPaths(repoRoot: string, command: string, tests: readonly string[]): string[] {
    const classification = getClassificationConfig(repoRoot);
    if (!tests.length) return [];
    let tokens: string[];
    try { const chain = parseCommandChain(command); if (chain.length !== 1) return []; tokens = chain[0]; }
    catch { return []; } // The command-contract guard handles invalid syntax.
    const executable = path.posix.basename((tokens[0] || '').replace(/\\/gu, '/')).toLowerCase();
    let excluded: string[] = [];
    if (/^(?:mvn|mvnw)(?:\.cmd|\.bat|\.exe)?$/u.test(executable)) {
        const selectors = tokens.filter(token => /^-D(?:test|it.test)=/u.test(token));
        if (selectors.length) {
            // Exact class selectors are decisive. Complex expressions are not guessed.
            const values = selectors.flatMap(token => token.slice(token.indexOf('=') + 1).split(','));
            if (values.every(value => /^[A-Za-z_$][\w.$]*(?:#[\w$]+)?$/u.test(value))) {
                const classes = values.map(value => value.split('#')[0]);
                excluded = tests.filter(file => /\.(?:java|kt|groovy)$/u.test(file)
                    && !classes.some(name => file.endsWith('/' + name.replace(/\./gu, '/') + path.posix.extname(file))));
            }
        }
    } else if ((/^(?:node|python[0-9.]*|pytest)(?:\.exe)?$/u.test(executable)
        && (executable.startsWith('pytest') || tokens.includes('--test') || tokens.includes('pytest')))
        || /^(?:vitest|jest)(?:\.cmd|\.exe)?$/u.test(executable)) {
        const targets = tokens.slice(1).filter(token => !token.startsWith('-') && !token.includes('=')
            && (isTestScopePath(token.split('::')[0], classification.test_trigger_regexes, classification.file_roles)
                || isExistingDirectory(repoRoot, token)))
            .map(token => token.split('::')[0].replace(/\\/gu, '/').replace(/^\.\//u, ''));
        if (targets.length && targets.every(target => !/[*?\[\]{}]/u.test(target))) {
            excluded = tests.filter(file => !targets.some(target => file === target || file.startsWith(target.replace(/\/$/u, '') + '/')));
        }
    }
    return excluded;
}

export function getFullSuiteTestSelectionViolations(repoRoot: string, command: string, changedFiles: readonly string[]): string[] {
    const violations = formatFullSuiteTestSelectionViolations(getExcludedChangedTests(repoRoot, command, changedFiles));
    try {
        const tokens = parseCommandChain(command).flat();
        if (tokens.some(token => /^(?:-D(?:skipTests|maven\.test\.skip|surefire\.skip|failsafe\.skip)(?:=(?!false$).*)?|--test-skip-pattern(?:=.*)?|--deselect(?:=.*)?)$/iu.test(token))) {
            violations.push('The selected test command explicitly skips tests. Select a command that runs the task tests.');
        }
    } catch { /* The command contract reports invalid syntax. */ }
    return violations;
}

export function formatFullSuiteTestSelectionViolations(excluded: readonly string[]): string[] {
    return excluded.length ? ['Configured test command explicitly excludes current changed tests: ' + excluded.join(', ')
        + '. Select current task tests through the audited workflow test-selection route (or an operator-approved project runner), refresh preflight, and rerun validation. Do not disable the test gate.'] : [];
}
