import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUNDLE, buildRuntime, cli, command, createProject, tempRoot, type CommandResult, type Project, type Runtime } from '../migration/p4-fixtures';
import { getWorkspaceSnapshotCached, invalidateSnapshotCache, resolveSnapshotCachePath } from '../../../src/gates/workspace/workspace-snapshot-cache';

/*
 * Field regressions of the 1.4.4 final review that live outside one navigator walk: updating a real installed
 * previous release that carries operator edits, refreshing managed rule sections, and a persistent cache whose key
 * must cover every input it reads. Expectations come from the update and freshness rules, never from product output:
 * operator bytes survive, the shipped template's managed contract is present, the prior file is backed up, the
 * real VERIFY passes, and a cached result always equals a fresh computation of the same inputs.
 */

/** The published 1.4.3 tree. CI may receive the tree without the tag history. */
export const PREVIOUS_RELEASE_TREE = '53bcf92a0aa0b497ed2b28baeb32f9531e7ed282';
export const PREVIOUS_RELEASE_TAG = 'v1.4.3';
const COMMANDS = BUNDLE + '/live/docs/agent-rules/40-commands.md';
const ANSWERS = BUNDLE + '/runtime/init-answers.json';
const SELECTOR = 'manual-validation-evidence-selector';
const marker = (id: string, edge: 'start' | 'end') => '<!-- garda:rule-section:' + id + ':' + edge + ' -->';

let root: string;
let previous: Runtime;
let candidate: Runtime;
before(() => {
    root = tempRoot();
    const tag = command('git', ['rev-parse', '--verify', '--quiet', PREVIOUS_RELEASE_TAG + '^{tree}'], process.cwd());
    if (tag.code === 0) assert.equal(tag.output.trim(), PREVIOUS_RELEASE_TREE, 'The pinned previous release tree must be the published tag');
    previous = buildRuntime(root, PREVIOUS_RELEASE_TREE);
    candidate = buildRuntime(root, 'HEAD', true);
}, { timeout: 900_000 });
after(() => {
    if (root && path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('garda-p4-')) {
        for (const runtime of [previous, candidate]) {
            const link = runtime && path.join(runtime.root, 'node_modules');
            if (link && fs.existsSync(link)) fs.rmSync(link, { recursive: false, force: true });
        }
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
});

function read(project: Project, relative = COMMANDS): Buffer { return fs.readFileSync(path.join(project.root, relative)); }

/** A managed section of the shipped template, independently located by its ownership markers. */
function templateSection(runtime: Runtime, id: string): string {
    const text = fs.readFileSync(path.join(runtime.root, 'template/docs/agent-rules/40-commands.md'), 'utf8');
    const start = text.indexOf(marker(id, 'start')), end = text.indexOf(marker(id, 'end'));
    assert.ok(start >= 0 && end > start, 'The shipped template owns section ' + id);
    const close = text.indexOf('\n', end);
    return text.slice(start, close < 0 ? text.length : close + 1);
}

/** Markers must be well formed: every section opens once and closes before another opens. */
function markerViolations(text: string): string[] {
    const problems: string[] = [];
    let open: string | null = null;
    const seen = new Set<string>();
    for (const match of text.matchAll(/<!-- garda:rule-section:([a-z0-9-]+):(start|end) -->/gu)) {
        const [, id, edge] = match;
        if (edge === 'start') {
            if (open) problems.push('nested ' + id + ' inside ' + open);
            if (seen.has(id)) problems.push('duplicate ' + id);
            open = id; seen.add(id);
        } else if (open !== id) problems.push('unbalanced end ' + id);
        else open = null;
    }
    if (open) problems.push('unclosed ' + open);
    return problems;
}

/** The prior bytes must be retained somewhere under the bundle's runtime, as a backup the operator can restore. */
function backupExists(project: Project, bytes: Buffer): boolean {
    const visit = (directory: string): boolean => fs.existsSync(directory) && fs.readdirSync(directory, { withFileTypes: true })
        .some(entry => entry.isDirectory() ? visit(path.join(directory, entry.name))
            : entry.isFile() && fs.statSync(path.join(directory, entry.name)).size === bytes.length
                && fs.readFileSync(path.join(directory, entry.name)).equals(bytes));
    return visit(path.join(project.root, BUNDLE, 'runtime'));
}

function updateWith(project: Project, launcher: string): CommandResult {
    return cli(project, ['update', '--target-root', project.root, '--init-answers-path', ANSWERS, '--source-path', candidate.root,
        '--trust-override', '--no-prompt'], launcher, 300_000);
}

/** The deployed bundle's own VERIFY, through the installed launcher after the update. */
function assertVerifyPasses(project: Project): void {
    const doctor = cli(project, ['doctor', '--target-root', project.root, '--json'], project.cli, 180_000);
    assert.equal(doctor.code, 0, 'Installed doctor/VERIFY must pass after the update:\n' + doctor.output);
}

function assertUpdatedTo(project: Project, runtime: Runtime): void {
    assert.equal(fs.readFileSync(path.join(project.root, BUNDLE, 'VERSION'), 'utf8').trim(),
        fs.readFileSync(path.join(runtime.root, 'VERSION'), 'utf8').trim(), 'The bundle must be the candidate release after the update');
}

const operatorBlock = '```bash\r\n# Project commands: 日本語, $& and `literal`  \r\n'
    + 'project action --flag="keep  spaces"\r\n'.repeat(16000) + '```\r\n';

for (const launcher of ['candidate', 'installed'])
    test(`field R3-1-A: a previous release with a large operator block under Skill Packs updates through the ${launcher} launcher`,
        { timeout: 900_000 }, () => {
            const project = createProject(root, previous, 'r3-1-a-' + launcher);
            const installed = read(project).toString('utf8');
            const heading = /^### Skill Packs\r?\n/mu.exec(installed);
            assert.ok(heading, 'The previous release installs the Skill Packs heading');
            const edited = Buffer.from(installed.slice(0, heading.index + heading[0].length) + operatorBlock
                + installed.slice(heading.index + heading[0].length));
            assert.ok(edited.length > 500_000);
            fs.writeFileSync(path.join(project.root, COMMANDS), edited);
            const update = updateWith(project, launcher === 'candidate' ? candidate.cli : project.cli);
            assert.equal(update.code, 0, 'Update from the previous release with operator edits must succeed:\n' + update.output.slice(-6000));
            assertUpdatedTo(project, candidate);
            const after = read(project).toString('utf8');
            assert.ok(after.includes(operatorBlock), 'The operator block survives byte for byte');
            const section = templateSection(candidate, SELECTOR);
            assert.ok(after.includes(section), 'The shipped managed selector contract is present');
            assert.deepEqual(Buffer.from(after.replace(section, '')), edited, 'Only the missing managed section is added');
            assert.ok(backupExists(project, edited), 'The edited prior file is backed up');
            assertVerifyPasses(project);
        });

test('field R3-1-B: an unedited previous release migrates with a backup and passes VERIFY', { timeout: 900_000 }, () => {
    const project = createProject(root, previous, 'r3-1-b');
    const installed = read(project);
    const update = updateWith(project, candidate.cli);
    assert.equal(update.code, 0, update.output.slice(-6000));
    assertUpdatedTo(project, candidate);
    const after = read(project).toString('utf8');
    assert.ok(after.includes(templateSection(candidate, SELECTOR)), 'The managed selector contract is installed');
    assert.deepEqual(markerViolations(after), []);
    assert.ok(backupExists(project, installed), 'The prior file is backed up');
    assertVerifyPasses(project);
});

/** Current marked install, then one operator-visible change; reinit is the documented refresh of managed rules. */
function reinit(project: Project): CommandResult {
    return cli(project, ['reinit', '--target-root', project.root, '--init-answers-path', ANSWERS, '--no-prompt'], project.cli, 300_000);
}

test('field C2-1: an outdated marked selector is refreshed from the template and outside operator text is kept', { timeout: 900_000 }, () => {
    const project = createProject(root, candidate, 'c2-1');
    const installed = read(project).toString('utf8');
    const section = templateSection(candidate, SELECTOR);
    assert.ok(installed.includes(section));
    const body = section.split('\n').find(line => /\S/u.test(line) && !line.startsWith('<!--') && !line.startsWith('#'))!;
    const outside = '\r\n## Operator runbook\r\nKeep 日本語, $& and trailing spaces.  \r\n';
    const stale = outside + installed.replace(section, () => section.replace(body, 'An earlier selector contract line.'))
        .replace(marker(SELECTOR, 'start'), () => outside + marker(SELECTOR, 'start'));
    fs.writeFileSync(path.join(project.root, COMMANDS), stale);
    const before = Buffer.from(stale);
    const refreshed = reinit(project);
    assert.equal(refreshed.code, 0, refreshed.output.slice(-6000));
    const after = read(project).toString('utf8');
    assert.ok(after.includes(section), 'The managed selector equals the shipped template again');
    assert.equal(after.split(outside).length - 1, 2, 'Operator text outside managed sections survives');
    assert.deepEqual(markerViolations(after), []);
    assert.ok(backupExists(project, before), 'The prior bytes are backed up');
    assertVerifyPasses(project);
});

test('field C2-6: a marked file without the selector and with an edited Skill Packs section keeps well-formed markers', { timeout: 900_000 }, () => {
    const project = createProject(root, candidate, 'c2-6');
    const installed = read(project).toString('utf8');
    const section = templateSection(candidate, SELECTOR);
    // Content inside a managed section is Garda-owned; only operator text outside the markers is guaranteed.
    const inside = 'Operator Skill Packs note: 日本語, $& and `literal`  \r\n';
    const operator = '\r\n## Operator skill notes\r\nKeep 日本語, $& and trailing spaces.  \r\n';
    const skills = marker('skill-packs', 'end');
    assert.ok(installed.includes(section) && installed.includes(skills));
    const edited = installed.replace(section, '').replace(/^### Skill Packs\r?\n/mu, match => match + inside)
        .replace(skills, () => skills + operator);
    assert.notEqual(edited, installed);
    fs.writeFileSync(path.join(project.root, COMMANDS), edited);
    const first = reinit(project);
    assert.equal(first.code, 0, first.output.slice(-6000));
    const once = read(project).toString('utf8');
    assert.deepEqual(markerViolations(once), [], 'Inserting the selector must not nest ownership markers');
    assert.ok(once.includes(section), 'The missing managed selector is restored from the template');
    assert.ok(once.includes(operator), 'Operator text outside managed sections survives');
    const second = reinit(project);
    assert.equal(second.code, 0, second.output.slice(-6000));
    const twice = read(project).toString('utf8');
    // The proposal requires stable ownership and operator text, not a fixed line-terminator style of Garda's own marker lines.
    const eol = (text: string) => text.replace(/\r\n/gu, '\n');
    const at = [...eol(twice)].findIndex((char, index) => char !== eol(once)[index]);
    assert.equal(eol(twice), eol(once), 'A second refresh changes no content; first difference at ' + at);
    assert.deepEqual(markerViolations(twice), []);
    assert.ok(twice.includes(operator) && twice.includes(section), 'The second refresh keeps operator text and the selector');
    assertVerifyPasses(project);
});

/** Perturb one input the snapshot reads; the cached answer must equal a fresh computation of the same inputs. */
function snapshotFacts(repoRoot: string) {
    const value = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
    return { changed: [...value.changed_files].sort(), ignored: [...value.ignored_build_output_files ?? []].sort() };
}

test('field F1: every workspace-snapshot cache hit equals a fresh snapshot after each build-output configuration change', { timeout: 900_000 }, () => {
    const project = createProject(root, candidate, 'f1');
    const pathsFile = path.join(project.root, BUNDLE, 'live/config/paths.json');
    const original = JSON.parse(fs.readFileSync(pathsFile, 'utf8')) as Record<string, unknown>;
    const defaults = original.untracked_build_output_regexes as string[];
    assert.ok(Array.isArray(defaults) && defaults.some(item => item.includes('build')), 'The installed filter treats build/ as output');
    fs.mkdirSync(path.join(project.root, 'src/build'), { recursive: true });
    fs.writeFileSync(path.join(project.root, 'src/build/feature.ts'), 'export const feature = true;\n');
    const configure = (patterns: string[]) => fs.writeFileSync(pathsFile, JSON.stringify({ ...original, untracked_build_output_regexes: patterns }, null, 2) + '\n');
    const fresh = () => { invalidateSnapshotCache(project.root); return snapshotFacts(project.root); };
    const variants: Array<[string, string[]]> = [['without build/', defaults.filter(item => !item.includes('build'))],
        ['defaults again', defaults], ['empty', []], ['reordered duplicates', [...defaults].reverse().concat(defaults)]];
    for (const persisted of [false, true]) {
        configure(defaults);
        const warm = fresh();
        assert.ok(!warm.changed.includes('src/build/feature.ts'), 'The default filter excludes the untracked build output');
        const cacheFile = resolveSnapshotCachePath(project.root);
        const signed = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile) : null;
        for (const [label, patterns] of variants) {
            configure(patterns);
            if (persisted && signed) { invalidateSnapshotCache(project.root); fs.writeFileSync(cacheFile, signed); }
            const cached = snapshotFacts(project.root);
            assert.deepEqual(cached, fresh(), `A ${persisted ? 'persisted' : 'in-process'} cache hit after "${label}" must equal a fresh snapshot`);
        }
    }
    configure([]);
    assert.ok(fresh().changed.includes('src/build/feature.ts'), 'Without a build-output filter the untracked source is in scope');
});
