import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTaskTestCommandContainerChecker, taskTestCommandIncludesContainer } from '../../../../src/gates/full-suite/task-test-command-inclusion';
import { startTaskTestExecutionProof, completeTaskTestExecutionProof, taskTestExecutionProofSatisfied } from '../../../../src/gates/full-suite/task-test-execution-proof';

test('literal Node admission captures every command file including undeclared companion tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-node-inclusion-'));
    try {
        for (const file of ['first.test.js', 'second.test.js']) fs.writeFileSync(path.join(root, file), 'require("node:test");');
        const inputs = new Map<string, string>();
        const includes = createTaskTestCommandContainerChecker('node --test first.test.js second.test.js', root,
            true, (file, sha256) => inputs.set(file, sha256));
        assert.equal(includes('first.test.js'), true);
        assert.deepEqual([...inputs.keys()], ['first.test.js', 'second.test.js']);
        for (const sha256 of inputs.values()) assert.match(sha256, /^[a-f0-9]{64}$/u);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('module inclusion requires a literal top-level reactor member and a test-running phase', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-module-inclusion-'));
    const target = 'application/src/test/java/example/StatusTest.java';
    const command = 'mvn -f pom.xml -pl application -am verify';
    try {
        fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
        fs.writeFileSync(path.join(root, target), 'class StatusTest {}');
        fs.writeFileSync(path.join(root, 'application/pom.xml'), '<project/>');
        const pom = path.join(root, 'pom.xml');
        fs.writeFileSync(pom, '<project><modules><module>application</module></modules></project>');
        assert.equal(taskTestCommandIncludesContainer(command, root, target), true);
        for (const invalid of [command + ' -DskipTests', command.replace('verify', 'package'),
            command.replace('application', 'other'), 'node --test application']) {
            assert.equal(taskTestCommandIncludesContainer(invalid, root, target), false, invalid);
        }
        for (const content of [
            '<project><profiles><profile><modules><module>application</module></modules></profile></profiles></project>',
            '<project><build><plugins><plugin><configuration><module>application</module></configuration></plugin></plugins></build></project>',
            '<project><modules><module>${selectedModule}</module></modules></project>',
            '<project><modules><module>application</module></modules>',
            '<!DOCTYPE project><project><modules><module>application</module></modules></project>'
        ]) {
            fs.writeFileSync(pom, content);
            assert.equal(taskTestCommandIncludesContainer(command, root, target), false, content);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Maven module and repository parent skip, excludes and ambiguous includes are refused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-maven-skip-'));
    const target = 'application/src/test/java/example/StatusTest.java';
    const command = 'mvn -f pom.xml -pl application verify';
    try {
        fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
        fs.writeFileSync(path.join(root, target), 'package example; class StatusTest {}');
        const reactor = '<modules><module>application</module></modules>';
        for (const config of [
            '<properties><skipTests>true</skipTests></properties>',
            '<properties><maven.test.skip>true</maven.test.skip></properties>',
            ...['maven-surefire-plugin', 'maven-failsafe-plugin'].flatMap(plugin => [
                '<skip>true</skip>', '<skipTests>true</skipTests>', '<skipTests>${test.skip}</skipTests>',
                '<excludes><exclude>**/StatusTest.java</exclude></excludes>',
                '<includes><include>**/OtherTest.java</include></includes>'
            ].map(configuration => `<build><plugins><plugin><artifactId>${plugin}</artifactId><configuration>${configuration}</configuration></plugin></plugins></build>`))
        ]) {
            for (const location of ['module', 'parent'] as const) {
                fs.writeFileSync(path.join(root, 'pom.xml'), `<project>${reactor}${location === 'parent' ? config : ''}</project>`);
                fs.writeFileSync(path.join(root, 'application/pom.xml'), `<project><parent><relativePath>../pom.xml</relativePath></parent>${location === 'module' ? config : ''}</project>`);
                assert.equal(taskTestCommandIncludesContainer(command, root, target), false, location + config);
            }
        }
        fs.writeFileSync(path.join(root, 'pom.xml'), `<project>${reactor}</project>`);
        fs.writeFileSync(path.join(root, 'application/pom.xml'), '<project><parent><relativePath>../pom.xml</relativePath></parent><properties><skipTests>false</skipTests></properties></project>');
        assert.equal(taskTestCommandIncludesContainer(command, root, target), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Maven execution proof accepts a fresh executed class and refuses missing, stale, skipped or foreign reports', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-maven-proof-'));
    const target = 'application/src/test/java/example/StatusTest.java';
    const command = 'mvn -f pom.xml -pl application verify';
    const report = path.join(root, 'application/target/surefire-reports/TEST-example.StatusTest.xml');
    try {
        fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
        fs.writeFileSync(path.join(root, target), 'package example; class StatusTest {}');
        fs.mkdirSync(path.dirname(report), { recursive: true });
        fs.writeFileSync(report, '<testsuite><testcase classname="example.StatusTest" name="old"/></testsuite>');
        for (const outcome of ['stale', 'missing', 'skipped', 'foreign', 'runs'] as const) {
            // Establish a real before observation after deletion: Windows file tunneling can
            // otherwise preserve the deleted file's birth time and make the next write ambiguous.
            if (!fs.existsSync(report)) fs.writeFileSync(report, '<testsuite><testcase classname="example.StatusTest" name="before"/></testsuite>');
            const start = startTaskTestExecutionProof(root, command, [target]);
            await new Promise(resolve => setTimeout(resolve, 20));
            if (outcome === 'missing') fs.rmSync(report, { force: true });
            else if (outcome !== 'stale') fs.writeFileSync(report,
                `<testsuite><testcase classname="${outcome === 'foreign' ? 'example.OtherTest' : 'example.StatusTest'}" name="${outcome}">${outcome === 'skipped' ? '<skipped/>' : ''}</testcase></testsuite>`);
            const proof = completeTaskTestExecutionProof(root, start);
            assert.equal(proof.violations.length === 0, outcome === 'runs', outcome);
            if (outcome === 'skipped') assert.match(proof.violations.join(' '), /skipped, failed or errored/u);
            assert.equal(proof.reports.length, ['runs', 'skipped', 'foreign'].includes(outcome) ? 1 : 0, outcome);
            if (proof.reports.length) assert.match(proof.reports[0].start.anchor.identity.path, /(?:^|\/)runtime\/validation-output\/task-test-proof-/u);
            assert.equal(taskTestExecutionProofSatisfied(command, [target], proof.reports), outcome === 'runs', outcome);
            assert.equal(taskTestExecutionProofSatisfied(command, [target], undefined), false);
            assert.equal(taskTestExecutionProofSatisfied(command, ['application/src/test/java/other/StatusTest.java'], proof.reports), false);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Maven root and arbitrarily nested modules bind fresh Surefire and Failsafe execution to the exact class', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-maven-layout-'));
    const command = 'mvn -o -Dtest=example.StatusTest test';
    try {
        for (const module of ['', 'application', 'backend/services/status/application']) {
            const target = path.posix.join(module, 'src/test/java/example/StatusTest.java');
            fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
            fs.writeFileSync(path.join(root, target), 'package example; class StatusTest {}');
            for (const directory of ['surefire-reports', 'failsafe-reports']) {
                const reportRelative = path.posix.join(module, 'target', directory, 'TEST-example.StatusTest.xml');
                const report = path.join(root, reportRelative);
                const start = startTaskTestExecutionProof(root, command, [target]);
                assert.deepEqual(start[0].starts.map(capture => capture.declarations[0].path),
                    ['surefire-reports', 'failsafe-reports'].map(dir => path.posix.join(module, 'target', dir, 'TEST-example.StatusTest.xml')));
                await new Promise(resolve => setTimeout(resolve, 5));
                fs.mkdirSync(path.dirname(report), { recursive: true });
                fs.writeFileSync(report, '<testsuite><testcase classname="example.StatusTest" name="runs"/></testsuite>');
                const proof = completeTaskTestExecutionProof(root, start);
                assert.deepEqual(proof.violations, [], reportRelative);
                assert.equal(taskTestExecutionProofSatisfied(command, [target], proof.reports), true, reportRelative);
                assert.equal(taskTestExecutionProofSatisfied(command, [path.posix.join('other', target)], proof.reports), false);
                fs.rmSync(report);
            }
            fs.writeFileSync(path.join(root, target), 'package wrong; class StatusTest {}');
            assert.deepEqual(startTaskTestExecutionProof(root, command, [target]), [], 'An inconclusive adapter falls back to generic execution.');
        }
        const ambiguous = 'src/test/java/nested/src/test/java/example/StatusTest.java';
        fs.mkdirSync(path.dirname(path.join(root, ambiguous)), { recursive: true });
        fs.writeFileSync(path.join(root, ambiguous), 'package example; class StatusTest {}');
        assert.deepEqual(startTaskTestExecutionProof(root, command, [ambiguous]), []);
        assert.equal(taskTestExecutionProofSatisfied(command, [ambiguous], []), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Maven container probes and POM reads stay constant for 100 targets in one invocation and refresh on the next', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-maven-container-probes-'));
    const command = 'mvn -f pom.xml -pl backend/application verify';
    const native = require('node:fs') as { lstatSync: typeof fs.lstatSync; realpathSync: typeof fs.realpathSync; openSync: typeof fs.openSync };
    const lstat = native.lstatSync, realpath = native.realpathSync.native, open = native.openSync;
    try {
        fs.mkdirSync(path.join(root, 'backend/application'), { recursive: true });
        fs.writeFileSync(path.join(root, 'pom.xml'), '<project><modules><module>backend/application</module></modules></project>');
        const modulePom = path.join(root, 'backend/application/pom.xml');
        fs.writeFileSync(modulePom, '<project/>');
        for (const inspectConfiguration of [false, true]) {
            const measure = (count: number) => {
                const counters = { lstat: 0, realpath: 0, pomReads: 0 };
                native.lstatSync = ((...args: Parameters<typeof lstat>) => { counters.lstat++; return lstat(...args); }) as typeof lstat;
                native.realpathSync.native = ((...args: Parameters<typeof realpath>) => { counters.realpath++; return realpath(...args); }) as typeof realpath;
                native.openSync = ((...args: Parameters<typeof open>) => {
                    if (String(args[0]).endsWith('pom.xml')) counters.pomReads++;
                    return open(...args);
                }) as typeof open;
                try {
                    const includes = createTaskTestCommandContainerChecker(command, root, inspectConfiguration);
                    for (let index = 0; index < count; index++) {
                        assert.equal(includes(`backend/application/src/test/java/example/Status${index}Test.java`), true);
                    }
                    assert.equal(includes('backend/unrelated/src/test/java/example/StatusTest.java'), false);
                    return counters;
                } finally { native.lstatSync = lstat; native.realpathSync.native = realpath; native.openSync = open; }
            };
            const one = measure(1), hundred = measure(100);
            assert.ok(one.lstat > 0 && one.realpath > 0 && one.pomReads > 0);
            assert.deepEqual(hundred, one, `inspectConfiguration=${inspectConfiguration}`);
        }
        fs.writeFileSync(modulePom, '<project><properties><skipTests>true</skipTests></properties></project>');
        assert.equal(createTaskTestCommandContainerChecker(command, root)('backend/application/src/test/java/example/StatusTest.java'), false);
        fs.rmSync(modulePom);
        assert.equal(createTaskTestCommandContainerChecker(command, root, false)('backend/application/src/test/java/example/StatusTest.java'), false);
    } finally {
        native.lstatSync = lstat; native.realpathSync.native = realpath; native.openSync = open;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
