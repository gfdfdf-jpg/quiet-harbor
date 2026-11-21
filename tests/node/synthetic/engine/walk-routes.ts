import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { observeStandOracle } from './stand-check-observation';

export interface SourceRoute {
    id: string;
    file: string;
    line: number;
    gates: string[];
    blocked: boolean;
    expression: string;
    unresolvedGates?: string[];
    unresolvedStatuses?: string[];
}
export interface RouteInventory { gates: string[]; points: SourceRoute[] }

// This route builder is invoked by next-step but lives with its parent-audit feature.
export const EXTERNAL_NAVIGATION_SOURCES = ['src/gates/parent-audit/parent-audit-navigation.ts'] as const;

function strings(node: ts.Node, bindings: ReadonlyMap<string, ts.Expression[]> = new Map(), seen = new Set<string>()): string[] {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue, bindings, seen), ...strings(node.whenFalse, bindings, seen)];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return strings(node.expression, bindings, seen);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        return [...strings(node.left, bindings, seen), ...strings(node.right, bindings, seen)];
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
        const nested = new Set(seen); nested.add(node.text);
        return (bindings.get(node.text) ?? []).flatMap(value => strings(value, bindings, nested));
    }
    return [];
}

function property(node: ts.ObjectLiteralExpression, name: string): { initializer: ts.Expression } | undefined {
    for (const item of node.properties) {
        if (ts.isShorthandPropertyAssignment(item) && item.name.text === name) return { initializer: item.name };
        if (!ts.isPropertyAssignment(item)) continue;
        if (ts.isComputedPropertyName(item.name)) {
            if (ts.isStringLiteralLike(item.name.expression) && item.name.expression.text === name) return item;
        } else if ((ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) && item.name.text === name) return item;
    }
    return undefined;
}

// Forwarding a route's nextGate introduces no new value. Every other unresolvable value must fail
// accounting even when no scenario reaches it: an imported/computed new gate cannot silently disappear.
function unresolvedValueAtoms(node: ts.Node, source: ts.SourceFile, field: 'gate' | 'status', bindings: ReadonlyMap<string, ts.Expression[]> = new Map(), seen = new Set<string>()): string[] {
    if (ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.NullKeyword) return [];
    if (ts.isConditionalExpression(node)) return [...unresolvedValueAtoms(node.whenTrue, source, field, bindings, seen), ...unresolvedValueAtoms(node.whenFalse, source, field, bindings, seen)];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return unresolvedValueAtoms(node.expression, source, field, bindings, seen);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        return [...unresolvedValueAtoms(node.left, source, field, bindings, seen), ...unresolvedValueAtoms(node.right, source, field, bindings, seen)];
    }
    if (ts.isPropertyAccessExpression(node) && (field === 'status' ? ['status'] : ['nextGate', 'next_gate']).includes(node.name.text)) return [];
    if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
        const nested = new Set(seen); nested.add(node.text);
        return bindings.get(node.text)!.flatMap(value => unresolvedValueAtoms(value, source, field, bindings, nested));
    }
    return [node.getText(source)];
}

function point(node: ts.Node, source: ts.SourceFile, file: string, bindings?: ReadonlyMap<string, ts.Expression[]>): SourceRoute | null {
    const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node : null;
    const field = assignment && ts.isPropertyAccessExpression(assignment.left) ? assignment.left.name.text
        : assignment && ts.isElementAccessExpression(assignment.left) && ts.isStringLiteralLike(assignment.left.argumentExpression)
            ? assignment.left.argumentExpression.text : null;
    const gate = ts.isObjectLiteralExpression(node) ? property(node, 'nextGate') ?? property(node, 'next_gate')
        : assignment && (field === 'nextGate' || field === 'next_gate') ? { initializer: assignment.right } : undefined;
    const status = ts.isObjectLiteralExpression(node) ? property(node, 'status')
        : assignment && field === 'status' ? { initializer: assignment.right } : undefined;
    const blocked = !!status && strings(status.initializer, bindings).includes('BLOCKED');
    if (!gate && !blocked) return null;
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { id: file + ':' + (location.line + 1) + ':' + (location.character + 1), file, line: location.line + 1,
        gates: gate ? [...new Set(strings(gate.initializer, bindings))].sort() : [], blocked,
        unresolvedGates: gate ? [...new Set(unresolvedValueAtoms(gate.initializer, source, 'gate', bindings))].sort() : [],
        unresolvedStatuses: status ? [...new Set(unresolvedValueAtoms(status.initializer, source, 'status', bindings))].sort() : [],
        expression: node.getText(source).slice(0, 1600) };
}

/** AST assignments, not regex hits, type declarations, comments or a manually curated gate list. */
export function extractRoutes(text: string, file: string): RouteInventory {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const bindings = new Map<string, ts.Expression[]>();
    const bind = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            bindings.set(node.name.text, [...bindings.get(node.name.text) ?? [], node.initializer]);
        }
        ts.forEachChild(node, bind);
    };
    bind(source);
    const points: SourceRoute[] = [];
    const visit = (node: ts.Node) => {
        const entry = point(node, source, file, bindings);
        if (entry) points.push(entry);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { points, gates: [...new Set(points.flatMap(entry => entry.gates))].sort() };
}

export function readRouteInventory(root: string): RouteInventory {
    const directory = path.join(root, 'src/gates/next-step');
    const collect = (current: string): string[] => fs.readdirSync(current, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(current, entry.name);
        return entry.isDirectory() ? collect(file) : entry.isFile() && entry.name.endsWith('.ts') ? [path.relative(directory, file).replace(/\\/gu, '/')] : [];
    });
    const files = collect(directory).sort();
    if (!files.length) throw new Error('No next-step source files found: ' + directory);
    const sources = [...files.map(file => 'src/gates/next-step/' + file), ...EXTERNAL_NAVIGATION_SOURCES];
    const points = sources.flatMap(file => extractRoutes(fs.readFileSync(path.join(root, file), 'utf8'), file).points);
    return { points, gates: [...new Set(points.flatMap(entry => entry.gates))].sort() };
}

// Test-only source instrumentation. Track object identity through nextGate reads and object spreads, all the
// way into renderNextStepOutput. An evaluated candidate is not coverage; only the returned object's lineage is.
// Construction frames prevent unrelated reads, including nested candidate evaluation, from contaminating it.
type Payload = Record<string, unknown>;
const lineage = new WeakMap<object, Set<string>>();
let frames: Set<Payload>[] = [];
const hookName = '__gardaSyntheticRoute';
let installed = false;
export function observeRouteConstruction(construct: () => Payload, id: string): Payload {
        const reads = new Set<Payload>(); frames.push(reads);
        let value: Payload;
        try { value = construct(); } finally { frames.pop(); }
        const key = 'nextGate' in value ? 'nextGate' : 'next_gate' in value ? 'next_gate' : null;
        if (!key) return value;
        const ids = new Set(id ? [id] : []);
        for (const parent of reads) {
            // Some routing wrappers append actionable detail while retaining the same decision.
            const sameReason = parent.reason === value.reason || (
                typeof parent.reason === 'string' && parent.reason.length > 0
                && typeof value.reason === 'string' && value.reason.startsWith(parent.reason + ' ')
                && typeof parent.title === 'string' && parent.title === value.title
            );
            if ((parent.nextGate ?? parent.next_gate ?? null) !== (value.nextGate ?? value.next_gate ?? null)
                || !sameReason || parent.status !== undefined && value.status !== undefined && parent.status !== value.status) continue;
            for (const sourceId of lineage.get(parent) ?? []) ids.add(sourceId);
        }
        lineage.set(value, ids);
        let gate = value[key];
        Object.defineProperty(value, key, { enumerable: true, configurable: true,
            get: () => { frames.at(-1)?.add(value); return gate; }, set: next => { gate = next; } });
        return value;
}
export function installRouteObserver(root: string): void {
    if (installed) return;
    if (Object.keys(require.cache).some(file => /\/src\/gates\/next-step\/.*\.js$/u.test(file.replace(/\\/gu, '/')))) {
        throw new Error('Install the synthetic route observer before importing next-step modules; late instrumentation cannot prove coverage.');
    }
    installed = true;
    const globals = globalThis as unknown as Record<string, unknown>;
    globals[hookName] = observeRouteConstruction;
    interface CompilingModule { _compile(text: string, filename: string): void }
    const extensions = (require('node:module') as { _extensions: Record<string, (module: CompilingModule, file: string) => void> })._extensions;
    const original = extensions['.js'];
    extensions['.js'] = (module, filename) => {
        const normalized = filename.replace(/\\/gu, '/');
        const suffix = /\/src\/gates\/(next-step\/.+|parent-audit\/parent-audit-navigation)\.js$/u.exec(normalized);
        if (!suffix) { original(module, filename); return; }
        const relative = 'src/gates/' + suffix[1] + '.ts';
        const sourceText = fs.readFileSync(path.join(root, relative), 'utf8');
        const transformed = ts.transpileModule(sourceText, {
            fileName: relative,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
            transformers: { before: [context => source => {
                const visit: ts.Visitor = node => {
                    const entry = point(node, source, relative);
                    const updated = ts.visitEachChild(node, visit, context);
                    const clone = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
                        && node.expression.name.text === 'fromEntries';
                    return ts.isObjectLiteralExpression(node) || clone ? context.factory.createCallExpression(context.factory.createElementAccessExpression(
                        context.factory.createIdentifier('globalThis'), context.factory.createStringLiteral(hookName)), undefined,
                    [context.factory.createArrowFunction(undefined, undefined, [], undefined, context.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                        updated as ts.Expression), context.factory.createStringLiteral(entry?.id ?? '')]) : updated;
                };
                return ts.visitNode(source, visit) as ts.SourceFile;
            }] }
        });
        module._compile(transformed.outputText, filename);
    };
}

export function beginRouteObservation(): void { frames = []; }
export function reachedRoutePoints(result: { next_gate: string | null; status: string; title?: string; reason: string }): string[] {
    return [...lineage.get(result) ?? []].sort();
}

export interface UncoveredRoute { id: string; reason: string }
export interface RouteCoverage {
    gates: Array<{ id: string; steps: number }>;
    blocked: Array<{ id: string; steps: number }>;
    reached: number;
    notReached: string[];
    unaccounted: string[];
    exemptions: UncoveredRoute[];
    invalidExemptions: string[];
}
export function routeCoverage(inventory: RouteInventory, steps: readonly { gate: string | null; status: string; routes?: string[]; stepId?: string }[], exemptions: UncoveredRoute[]): RouteCoverage {
    observeStandOracle('route-coverage');
    const count = (observations: typeof steps) => new Set(observations.map((step, index) => step.stepId ?? index)).size;
    const gates = inventory.gates.map(id => ({ id: 'gate:' + id, steps: count(steps.filter(step => step.gate === id)) }));
    const blocked = inventory.points.filter(entry => entry.blocked).map(entry => ({ id: entry.id,
        steps: count(steps.filter(step => step.status === 'BLOCKED' && step.routes?.includes(entry.id))) }));
    const all = [...gates, ...blocked], ids = new Set(all.map(entry => entry.id));
    const invalidExemptions = exemptions.filter(entry => !ids.has(entry.id) || !entry.reason?.trim()
        || /hard to reach|not yet|todo|unimplemented/iu.test(entry.reason)).map(entry => entry.id);
    const notReached = all.filter(entry => entry.steps === 0).map(entry => entry.id);
    const unknownObserved = [...new Set(steps.flatMap(step => step.gate && !inventory.gates.includes(step.gate) ? ['observed-only-gate:' + step.gate] : []))];
    const unknownSource = inventory.points.flatMap(entry => [
        ...(entry.unresolvedGates ?? []).map(atom => 'unresolved-source-gate:' + entry.id + ':' + atom),
        ...(entry.unresolvedStatuses ?? []).map(atom => 'unresolved-source-status:' + entry.id + ':' + atom)
    ]);
    return { gates, blocked, reached: all.length - notReached.length, notReached,
        unaccounted: [...notReached.filter(id => !exemptions.some(entry => entry.id === id && !invalidExemptions.includes(id))), ...unknownObserved, ...unknownSource],
        exemptions, invalidExemptions };
}
