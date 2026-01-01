import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { GATE_COMMANDS } from '../../../../src/compat/shim-registry';
import { standCheckPlan } from './stand-check-plan';
import { walkRunPlan } from './walk-plan';
import type { StandCheck } from './stand-summary';
import type { WalkReport } from './walk-report';

export type PropertyLevel = 'short' | 'full' | 'sweep';
export interface PropertyCheck {
    id: string; kind: 'suite' | 'contract' | 'oracle' | 'family' | 'budget' | 'timing';
    run: string; levels: PropertyLevel[]; file?: string; tests?: string[]; symbol?: string;
    caller?: string; scenarios?: Partial<Record<PropertyLevel, string[]>>; cases?: string[];
    inventoryPattern?: string; completeAt?: PropertyLevel[];
}
export interface StandProperty { id: string; statement: string; concept: string[]; gates: string[]; checks: string[]; levels?: PropertyLevel[] }
export interface StandProperties {
    schema_version: 1; concept_source: string; checks: PropertyCheck[]; properties: StandProperty[];
    limits: Array<{ unproved: string; external: string }>;
}
export function readStandProperties(root: string): StandProperties {
    return JSON.parse(fs.readFileSync(path.join(root, 'tests/node/synthetic/stand-properties.json'), 'utf8')) as StandProperties;
}
export interface DeclaredTest { name: string; template: boolean; active: boolean; cases?: string[] }
/** Parse registrations rather than accepting a matching comment, string or skipped test. */
export function declaredTests(source: string): DeclaredTest[] {
    const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
    const tests: DeclaredTest[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text === 'test'
            || ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(file) === 'test')) {
            const name = node.arguments[0];
            if (name && (ts.isStringLiteralLike(name) || ts.isTemplateExpression(name))) {
                const options = node.arguments[1];
                const disabled = ts.isPropertyAccessExpression(node.expression)
                    || options && ts.isObjectLiteralExpression(options) && options.properties.some(item => ts.isPropertyAssignment(item)
                        && ['skip', 'todo', 'only'].includes(item.name.getText(file).replace(/['"]/gu, '')) && item.initializer.kind !== ts.SyntaxKind.FalseKeyword);
                let cases: string[] | undefined;
                if (ts.isTemplateExpression(name) && name.templateSpans.length === 1) {
                    let parent: ts.Node | undefined = node.parent;
                    while (parent && !ts.isForOfStatement(parent)) parent = parent.parent;
                    if (parent && ts.isForOfStatement(parent) && ts.isArrayLiteralExpression(parent.expression)
                        && ts.isVariableDeclarationList(parent.initializer)
                        && parent.initializer.declarations[0].name.getText(file) === name.templateSpans[0].expression.getText(file)) {
                        cases = parent.expression.elements.map(value => name.head.text
                            + (ts.isStringLiteralLike(value) ? value.text : value.getText(file)) + name.templateSpans[0].literal.text);
                    }
                }
                tests.push({ name: ts.isTemplateExpression(name) ? name.head.text : name.text,
                    template: ts.isTemplateExpression(name), active: !disabled, ...(cases ? { cases } : {}) });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file); return tests;
}
function hasFunction(source: string, symbol: string): boolean {
    const file = ts.createSourceFile('oracle.ts', source, ts.ScriptTarget.Latest, true);
    return file.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === symbol && !!node.body?.statements.length);
}
function callsFunction(source: string, symbol: string): boolean {
    const file = ts.createSourceFile('caller.ts', source, ts.ScriptTarget.Latest, true);
    let found = false;
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === symbol) found = true;
        ts.forEachChild(node, visit);
    };
    visit(file); return found;
}
export interface TraceInventory {
    root: string; level: PropertyLevel; scenarioIds: string[]; seed?: string;
    /** Injectable inventories make negative controls exercise missing registrations and schedule drift. */
    gates?: readonly string[]; conceptText?: string; read?: (relative: string) => string;
    schedule?: ReturnType<typeof standCheckPlan>;
}
export function inspectStandProperties(manifest: StandProperties, inventory: TraceInventory): string[] {
    const problems: string[] = [];
    const read = inventory.read ?? ((file: string) => fs.readFileSync(path.join(inventory.root, file), 'utf8'));
    const rules = [...(inventory.conceptText ?? read(manifest.concept_source)).matchAll(/^- \[([A-Z][\w.-]+)\]/gmu)].map(match => match[1]);
    const schedule = inventory.schedule ?? standCheckPlan(inventory.level, read('tests/node/policy/stack-universal-gates-contract.test.ts'));
    const plan = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: inventory.level, GARDA_SYNTHETIC_SEED: inventory.seed ?? '1785881697' }, inventory.scenarioIds);
    const unique = (ids: string[], kind: string) => {
        if (new Set(ids).size !== ids.length) problems.push('Duplicate ' + kind);
    };
    unique(manifest.properties.map(property => property.id), 'property ID'); unique(manifest.checks.map(check => check.id), 'check ID'); unique(rules, 'concept rule ID');
    if (!rules.length || !manifest.properties.length || !manifest.checks.length) problems.push('Empty property/concept/check inventory');
    const propertyRules = manifest.properties.flatMap(property => property.concept);
    const propertyGates = manifest.properties.flatMap(property => property.gates);
    for (const rule of rules) if (!propertyRules.includes(rule)) problems.push('Unmapped concept rule: ' + rule);
    for (const rule of propertyRules) if (!rules.includes(rule)) problems.push('Unknown concept rule: ' + rule);
    const gates = inventory.gates ?? GATE_COMMANDS;
    for (const gate of gates) if (!propertyGates.includes(gate)) problems.push('Unmapped registry gate: ' + gate);
    for (const gate of propertyGates) if (!gates.includes(gate)) problems.push('Unknown registry gate: ' + gate);
    for (const property of manifest.properties) {
        if (!property.checks.length) problems.push('Property has no check: ' + property.id);
        for (const id of property.checks) if (!manifest.checks.some(check => check.id === id)) problems.push(property.id + ': missing check ' + id);
        if ((!property.levels || property.levels.includes(inventory.level))
            && !property.checks.some(id => manifest.checks.some(check => check.id === id && check.levels.includes(inventory.level))))
            problems.push('Property has no check at ' + inventory.level + ': ' + property.id);
    }
    for (const check of manifest.checks) {
        if (!manifest.properties.some(property => property.checks.includes(check.id))) problems.push('Orphan check: ' + check.id);
        if (!check.levels.length) problems.push('Check has no requested level: ' + check.id);
        if (!check.levels.includes(inventory.level)) continue;
        const run = schedule.find(item => item.id === check.run);
        if (!run) { problems.push('Check no longer scheduled: ' + check.id); continue; }
        try {
            if (check.tests) {
                const file = path.posix.normalize('tests/node/synthetic/' + run.file.replace(/\.js$/u, '.ts'));
                if (check.file !== file) problems.push('Check suite changed: ' + check.id);
                const registrations = declaredTests(read(check.file!));
                for (const name of check.tests) {
                    const test = registrations.find(item => item.name === name && item.active);
                    if (!test) problems.push('Check test missing/skipped: ' + check.id + ': ' + name);
                    // Templates use a nonempty witness; exact selection of generated tours is checked separately.
                    if (test && run.pattern && !new RegExp(run.pattern, 'u').test(test.template ? name + (check.run === 'contract-rename' ? 'true)' : 'false)') : name))
                        problems.push('Check filtered out at ' + inventory.level + ': ' + check.id + ': ' + name);
                }
                for (const name of check.cases ?? []) {
                    if (!registrations.some(test => test.active && (test.name === name || test.cases?.includes(name))))
                        problems.push('Generated case no longer registered: ' + check.id + ': ' + name);
                    if (run.pattern && !new RegExp(run.pattern, 'u').test(name)) problems.push('Generated case filtered out: ' + check.id + ': ' + name);
                }
            }
            if (check.symbol && (!check.file || !hasFunction(read(check.file), check.symbol)
                || !check.caller || !callsFunction(read(check.caller), check.symbol))) problems.push('Oracle no longer called: ' + check.id);
            if (check.scenarios) {
                const required = check.scenarios[inventory.level];
                if (!required?.length) problems.push('Scenario family has no level selection: ' + check.id);
                for (const id of required ?? []) if (!plan.scenarioIds.includes(id)) problems.push('Scenario no longer runs at ' + inventory.level + ': ' + id);
                if (check.inventoryPattern && check.completeAt?.includes(inventory.level))
                    for (const id of inventory.scenarioIds.filter(id => new RegExp(check.inventoryPattern!, 'u').test(id)))
                        if (!required?.includes(id)) problems.push('Unmapped scenario family member: ' + id);
            }
        } catch (error) { problems.push('Broken check ' + check.id + ': ' + String(error)); }
    }
    // A newly added contract test cannot be hidden by an older positive name filter.
    for (const test of declaredTests(read('tests/node/policy/stack-universal-gates-contract.test.ts'))) {
        if (!test.active || !manifest.checks.some(check => check.kind === 'contract' && check.tests?.includes(test.name)))
            problems.push('Unmapped/inactive contract case: ' + test.name);
    }
    return problems;
}

export type TraceStatus = 'PASS' | 'FAIL' | 'PENDING' | 'NOT_REQUESTED';
export interface PropertyTrace { id: string; statement: string; concept: string[]; gates: string[]; status: TraceStatus; checks: Array<{ id: string; run: string; status: TraceStatus; detail: string }> }
export function propertyTrace(manifest: StandProperties, input: { level: string; final: boolean; partial: boolean;
    only?: string[]; checks: StandCheck[]; walk?: WalkReport; timingRequested: boolean }): PropertyTrace[] {
    return manifest.properties.map(property => {
        const checks = property.checks.map(id => {
            const check = manifest.checks.find(item => item.id === id);
            if (!check) return { id, run: '', status: 'FAIL' as const, detail: 'Missing check' };
            const required = check.scenarios?.[input.level as PropertyLevel];
            let status: TraceStatus = 'PASS';
            let detail = check.symbol ? check.file + '#' + check.symbol : check.kind === 'contract'
                ? (check.cases ?? check.tests ?? []).join('; ') : check.tests ? check.file + ' (' + check.tests.length + ' registered cases)'
                    : required ? required.length + ' scenarios: ' + required.slice(0, 4).join(', ') + (required.length > 4 ? '; see walk/navigator-walk.json' : '') : check.run;
            if (!check.levels.includes(input.level as PropertyLevel) || check.run === 'timing' && !input.timingRequested
                || required && input.partial && !required.some(scenario => input.only?.includes(scenario))) status = 'NOT_REQUESTED';
            else {
                const run = input.checks.find(item => item.id === check.run);
                if (!run || run.status === 'running') status = input.final ? 'FAIL' : 'PENDING';
                else if (run.status === 'FAIL') status = 'FAIL';
                if (check.symbol && run?.status === 'PASS' && !run.oracles_executed?.includes(check.id)) {
                    status = 'FAIL'; detail = 'Oracle did not execute: ' + check.id;
                }
                if (required) for (const scenario of required.filter(scenario => !input.partial || input.only?.includes(scenario))) {
                    const result = input.walk?.scenarios.find(item => item.id === scenario);
                    if (!result) { status = input.final ? 'FAIL' : 'PENDING'; detail = 'Missing scenario: ' + scenario; }
                    else if (!['done', 'expected-handoff', 'expected-blocked', 'decomposed'].includes(result.outcome)) { status = 'FAIL'; detail = scenario + ': ' + result.outcome; }
                }
                if (check.tests && run?.status === 'PASS') for (const name of check.cases ?? check.tests)
                    if (!run.executed_tests?.some(actual => actual === name || actual.startsWith(name))) { status = 'FAIL'; detail = 'Test did not execute: ' + name; }
            }
            return { id, run: check.run, status, detail };
        });
        const relevant = checks.filter(check => manifest.checks.find(item => item.id === check.id)?.levels.includes(input.level as PropertyLevel));
        const status: TraceStatus = property.levels && !property.levels.includes(input.level as PropertyLevel) ? 'NOT_REQUESTED'
            : checks.some(check => check.status === 'FAIL') ? 'FAIL' : relevant.some(check => check.status === 'PENDING') ? 'PENDING'
                : !relevant.length || relevant.some(check => check.status === 'NOT_REQUESTED') ? 'NOT_REQUESTED' : 'PASS';
        return { ...property, checks, status };
    });
}
