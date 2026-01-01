import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCommandChain } from '../../core/command-line';

function safeRelative(value: string): boolean {
    return !!value && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
        && !value.split('/').some(part => part === '..' || part === '.')
        && !/[\u0000-\u001f*?\[\]{}:$%~!]/u.test(value);
}

function unlinkedPath(root: string, relative: string, directory: boolean): boolean {
    if (!safeRelative(relative)) return false;
    let current = path.resolve(root);
    try {
        for (const part of relative.split('/')) {
            current = path.join(current, part);
            if (fs.lstatSync(current).isSymbolicLink()) return false;
        }
        const stat = fs.lstatSync(current);
        return (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
            && fs.realpathSync.native(current) === path.resolve(root, relative);
    } catch { return false; }
}

function literalReactorModules(pom: string): string[] {
    const xml = pom.replace(/<!--[\s\S]*?-->/gu, '').replace(/<\?xml[^?]*\?>/u, '');
    if (/<!|<\?/u.test(xml)) return [];
    const stack: string[] = [], modules: string[] = [];
    let offset = 0, roots = 0;
    for (const tag of xml.matchAll(/<[^<>]*>/gu)) {
        const text = xml.slice(offset, tag.index).trim();
        const parsed = /^<(\/?)((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)(?:\s+[^<>]*?)?\s*(\/?)>$/u.exec(tag[0]);
        if (!parsed || text.includes('<') || (!stack.length && text)) return [];
        const [, closing, name, selfClosing] = parsed;
        const local = name.split(':').pop()!;
        if (closing) {
            if (stack.map(value => value.split(':').pop()).join('/') === 'project/modules/module') {
                if (!text || /[&$]/u.test(text)) return [];
                modules.push(text.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, ''));
            }
            if (stack.pop() !== name || selfClosing) return [];
        } else {
            if (!stack.length && (++roots !== 1 || local !== 'project')) return [];
            if (stack.map(value => value.split(':').pop()).join('/') === 'project/modules/module') return [];
            if (!selfClosing) stack.push(name);
        }
        offset = tag.index + tag[0].length;
    }
    return roots === 1 && !stack.length && !xml.slice(offset).trim() ? modules : [];
}

function mavenTestConfigurationAllows(root: string, relative: string, seen = new Set<string>()): boolean {
    if (seen.has(relative) || !unlinkedPath(root, relative, false)) return false;
    seen.add(relative);
    const xml = fs.readFileSync(path.join(root, relative), 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
    if (xml.length > 1024 * 1024 || /<!|<\?/u.test(xml.replace(/<\?xml[^?]*\?>/u, ''))) return false;
    // Refuse dynamic or restrictive configuration rather than guessing an effective Maven model.
    for (const tag of xml.matchAll(/<(?:[\w.-]+:)?(skipTests|maven\.test\.skip|surefire\.skip|failsafe\.skip|skip)\b[^>]*>([\s\S]*?)<\//gu)) {
        if (tag[2].trim().toLowerCase() !== 'false') return false;
    }
    if (/<(?:[\w.-]+:)?(?:includes|excludes)\b/u.test(xml)) return false;
    if (/<(?:[\w.-]+:)?(?:skipTests|maven\.test\.skip|surefire\.skip|failsafe\.skip|skip)\s*\//u.test(xml)) return false;
    const parent = /<parent\b[^>]*>([\s\S]*?)<\/parent>/u.exec(xml)?.[1];
    if (!parent && /<(?:[\w.-]+:)?parent\b/u.test(xml)) return false;
    if (!parent) return true;
    // A repository parent can be inspected. External effective configuration is ambiguous.
    const declared = /<relativePath\b[^>]*>([\s\S]*?)<\/relativePath>/u.exec(parent)?.[1]?.trim();
    if (/<relativePath\s*\/>/u.test(parent) || declared === '' || (declared && /[&$]/u.test(declared))) return false;
    const parentPath = path.posix.normalize(path.posix.join(path.posix.dirname(relative), declared ?? '../pom.xml'));
    return safeRelative(parentPath) && mavenTestConfigurationAllows(root, parentPath, seen);
}

/** Only a literal reactor module directory and a test-running phase establish module inclusion. */
function mavenModuleIncludes(tokens: string[], root: string, target: string, inspectConfiguration: boolean,
    modules: Map<string, boolean>): boolean {
    const executable = path.posix.basename(tokens[0].replace(/\\/gu, '/')).toLowerCase();
    if (!/^(?:mvn|mvnw)(?:\.cmd|\.bat|\.exe)?$/u.test(executable)) return false;
    let pom = '', module = '', phase = '';
    for (let i = 1; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token === '-f' || token === '--file') {
            if (pom || !tokens[i + 1]) return false;
            pom = tokens[++i];
        } else if (token === '-pl' || token === '--projects') {
            if (module || !tokens[i + 1]) return false;
            module = tokens[++i];
        } else if (token === '-am' || token === '--also-make' || token === '-o' || token === '--offline'
            || token === '-B' || token === '--batch-mode') {
            continue;
        } else if (['test', 'integration-test', 'verify'].includes(token)) {
            if (phase) return false;
            phase = token;
        } else return false;
    }
    pom = pom.replace(/\\/gu, '/').replace(/^\.\//u, '');
    module = module.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, '');
    if (!phase || !safeRelative(pom) || !safeRelative(module) || path.posix.basename(pom) !== 'pom.xml') return false;
    const moduleDir = path.posix.join(path.posix.dirname(pom), module);
    const modulePom = `${moduleDir}/pom.xml`;
    if (!target.startsWith(`${moduleDir}/src/test/java/`) || !target.endsWith('.java')) return false;
    const key = JSON.stringify([pom, module]);
    if (modules.has(key)) return modules.get(key)!;
    const included = inspectMavenModule(root, pom, module, moduleDir, modulePom, inspectConfiguration);
    modules.set(key, included);
    return included;
}

function inspectMavenModule(root: string, pom: string, module: string, moduleDir: string, modulePom: string,
    inspectConfiguration: boolean): boolean {
    if (!unlinkedPath(root, pom, false) || !unlinkedPath(root, moduleDir, true) || !unlinkedPath(root, modulePom, false)) return false;
    // Reject entity expansion and ambiguous dynamic module names. Maven must know this literal reactor member.
    const bytes = fs.readFileSync(path.join(root, pom), 'utf8');
    if (bytes.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/iu.test(bytes)) return false;
    return literalReactorModules(bytes).includes(module)
        && (!inspectConfiguration || (mavenTestConfigurationAllows(root, pom) && mavenTestConfigurationAllows(root, modulePom)));
}

function directoryIncludes(tokens: string[], root: string, target: string): boolean {
    const executable = path.posix.basename(tokens[0].replace(/\\/gu, '/')).toLowerCase();
    let directory = '';
    if (/^pytest(?:\.exe)?$/u.test(executable) && tokens.length === 2
        && /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/u.test(target)) directory = tokens[1];
    directory = directory.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, '');
    return safeRelative(directory) && target.startsWith(`${directory}/`) && unlinkedPath(root, directory, true);
}

function literalNodeFilesInclude(tokens: string[], root: string, target: string): boolean {
    return /^(?:node)(?:\.exe)?$/iu.test(path.basename(tokens[0])) && tokens[1] === '--test'
        && tokens.slice(2).includes(target) && tokens.slice(2).every(file => unlinkedPath(root, file, false));
}

/** One checker belongs to one validation/read invocation; no module observation survives into another call. */
export function createTaskTestCommandContainerChecker(command: string, root: string, inspectConfiguration = true): (target: string) => boolean {
    try {
        const chain = parseCommandChain(command);
        const modules = new Map<string, boolean>();
        return target => {
            try {
                return chain.length === 1 && (literalNodeFilesInclude(chain[0], root, target)
                    || mavenModuleIncludes(chain[0], root, target, inspectConfiguration, modules)
                    || directoryIncludes(chain[0], root, target));
            } catch { return false; }
        };
    } catch { return () => false; }
}

export function taskTestCommandIncludesContainer(command: string, root: string, target: string, inspectConfiguration = true): boolean {
    return createTaskTestCommandContainerChecker(command, root, inspectConfiguration)(target);
}
