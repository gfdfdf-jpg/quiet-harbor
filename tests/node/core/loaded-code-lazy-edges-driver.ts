import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { prepareClosedObservationPlanModules } from '../../../src/core/derivation-observation-recorder';
import { prepareRuntimeMutationGenerationCode } from '../../../src/gate-runtime/runtime-mutation-generation';
import { prepareTaskEventSummaryCode } from '../../../src/gate-runtime/timeline/task-events-io-summary';
import { prepareLoadedCodeLazyEdges } from '../../../src/core/loaded-code-lazy-edges';

const sourceRoot = path.resolve(__dirname, '../../../../src');
const runtimeRoot = path.resolve(__dirname, '../../../src');
const owner = process.argv[2] === 'terminal'
    ? ['gates/task-audit/task-audit-materialized-terminal', 'RENDERER_MODULES']
    : ['gates/review-attempts/review-closed-cycle-capture', 'roots'];
function sourceTree(file: string, text = fs.readFileSync(file, 'utf8')) {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function lazyRequires(tree: ts.SourceFile): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node, inside = false): void => {
        const inFunction = inside || ts.isFunctionLike(node);
        if (inFunction && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === 'require' && node.arguments.length === 1
            && ts.isStringLiteral(node.arguments[0]) && /^\.\.?\//u.test(node.arguments[0].text)) found.push(node.arguments[0].text);
        ts.forEachChild(node, child => visit(child, inFunction));
    };
    visit(tree); return [...new Set(found)];
}
assert.deepEqual(lazyRequires(sourceTree('syntax.ts',
    'require("./top"); function f(){ require("./lazy"); object.require("./method"); require(variable); }')), ['./lazy']);
const arrays: string[][] = [];
function findRoots(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === owner[1]
        && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        assert.ok(node.initializer.elements.every(ts.isStringLiteral));
        arrays.push(node.initializer.elements.map(element => (element as ts.StringLiteral).text));
    }
    ts.forEachChild(node, findRoots);
}
const ownerTree = sourceTree(path.join(sourceRoot, owner[0] + '.ts'));
findRoots(ownerTree);
const ownerFunction = owner[1] === 'roots' ? 'captureProducerModules' : 'rendererSemanticsBinding';
let ownersChecked = 0;
function checkOwner(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === ownerFunction) {
        const calls: string[] = [];
        const visit = (child: ts.Node): void => {
            if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) calls.push(child.expression.text);
            ts.forEachChild(child, visit);
        };
        visit(node);
        assert.deepEqual(calls.filter(name => name.startsWith('prepare')), ['prepareLoadedCodeLazyEdges']);
        assert.equal(calls.filter(name => name === 'captureLoadedCodeClosure').length, 1);
        assert.ok(calls.indexOf('prepareLoadedCodeLazyEdges') < calls.indexOf('captureLoadedCodeClosure'));
        ownersChecked += 1;
    }
    ts.forEachChild(node, checkOwner);
}
checkOwner(ownerTree); assert.equal(ownersChecked, 1);
assert.equal(arrays.length, 1, 'Find the actual owner root list, not a test duplicate');
const ownerFile = path.join(runtimeRoot, owner[0] + '.js');
const resolve = createRequire(ownerFile);
const roots = arrays[0].map(id => resolve.resolve(id));
for (const root of roots) require(root);
function closure(): Map<string, NodeModule> {
    const found = new Map<string, NodeModule>(), pending = [...roots];
    while (pending.length) {
        const file = pending.pop()!; if (found.has(file)) continue;
        const module = require.cache[file]; assert.ok(module); found.set(file, module);
        pending.push(...module.children.map(child => child.filename));
    }
    return found;
}
// Preserve the existing preparation baseline, including its intentional SQLite closure.
prepareClosedObservationPlanModules(); prepareRuntimeMutationGenerationCode(); prepareTaskEventSummaryCode();
const before = [...closure().keys()].sort();
prepareLoadedCodeLazyEdges();
const modules = closure();
assert.deepEqual([...modules.keys()].sort(), before, 'Pins may add edges, never new closure modules');
const missing: string[] = [];
let checked = 0;
for (const [file, module] of modules) {
    if (!/\.[cm]?js$/u.test(file)) continue;
    const source = file.startsWith(runtimeRoot + path.sep)
        ? path.join(sourceRoot, path.relative(runtimeRoot, file)).replace(/\.js$/u, '.ts') : file;
    assert.ok(fs.existsSync(source), 'Each runtime module must have matching source: ' + source);
    for (const id of lazyRequires(sourceTree(source))) {
        checked += 1;
        const target = createRequire(file).resolve(id);
        if (!module.children.some(child => child.filename === target)) missing.push(path.relative(sourceRoot, source) + ' -> ' + id);
    }
}
assert.ok(checked >= 6, 'Guard must inspect the real fixed lazy edges');
assert.deepEqual(missing, [], 'Function-local requires must be prepared before identity capture');
process.stdout.write(JSON.stringify({ owner: owner[0], modules: modules.size, checked }));
