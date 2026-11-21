import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const workflowNames = ['ci', 'security', 'secret-scanning', 'sbom', 'smoke-schedule', 'publish'] as const;
const documentWorkflows = [
    ['README.md', workflowNames],
    ['CONTRIBUTING.md', workflowNames],
    ['docs/manual-ci.md', workflowNames],
    ['docs/sbom.md', ['sbom']],
    ['docs/secret-scanning.md', ['secret-scanning']],
    ['docs/branch-protection.md', ['ci', 'security', 'secret-scanning', 'sbom']],
    ['docs/release-readiness.md', workflowNames],
    ['SECURITY.md', ['security', 'secret-scanning', 'sbom']]
] as const;

const triggerClaims: Readonly<Record<string, readonly RegExp[]>> = {
    push: [
        /^\s*[-*]\s*(?:every|each)\s+push\b/imu,
        /\b(?:CI|SBOM|security scans?|secret scanning|gitleaks|workflow)\s+(?:runs?|starts?|is generated)\s+(?:automatically\s+)?on\s+(?:every\s+)?push\b/iu,
        /\bthis checkout (?:still )?contains automatic push\/PR triggers\b/iu
    ],
    pull_request: [
        /^\s*[-*]\s*(?:every|each)\s+(?:pull[_ -]requests?|PRs?)\b/imu,
        /\b(?:CI|SBOM|security scans?|secret scanning|gitleaks|workflow)\s+(?:runs?|starts?|is generated)\s+(?:automatically\s+)?on\s+(?:every\s+)?(?:pull[_ -]requests?|PRs?)\b/iu,
        /\bthis checkout (?:still )?contains automatic push\/PR triggers\b/iu
    ],
    schedule: [
        /\b(?:CI|SBOM|security scans?|secret scanning|gitleaks|workflow)\s+(?:runs?|starts?|is generated)\s+(?:automatically\s+)?(?:nightly|daily|on (?:a )?schedule)\b/iu,
        /^\s*[-*]\s*(?:nightly|daily|scheduled)\s+(?:CI|SBOM|security|secret scanning)\b/imu
    ]
};

function readRepoFile(relativePath: string): string {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function readWorkflowEvents(content: string): Set<string> {
    const lines = content.split(/\r?\n/u);
    const start = lines.findIndex(line => /^on:\s*$/u.test(line));
    assert.notEqual(start, -1, 'Workflow must expose a readable top-level event mapping');
    const events = new Set<string>();
    for (const line of lines.slice(start + 1)) {
        if (!line.trim() || /^\s*#/u.test(line)) continue;
        if (/^\S/u.test(line)) break;
        const event = /^ {2}([a-z][a-z_]*):/u.exec(line)?.[1];
        if (event) events.add(event);
    }
    assert.ok(events.size, 'Workflow event mapping must not be empty or unsupported');
    return events;
}

function unsupportedTriggerClaims(content: string, events: ReadonlySet<string>): string[] {
    const text = content.replace(/`|\*\*/gu, '');
    const prose = text.replace(/\s+/gu, ' ');
    return Object.entries(triggerClaims)
        .filter(([event, patterns]) => !events.has(event) && patterns.some(pattern => pattern.test(text) || pattern.test(prose)))
        .map(([event]) => event);
}

test('repository workflow events are manual dispatch with explicit authorization', () => {
    for (const name of workflowNames) {
        const workflow = readRepoFile(`.github/workflows/${name}.yml`);
        assert.deepEqual([...readWorkflowEvents(workflow)], ['workflow_dispatch'], name);
        assert.match(workflow, /^\s+MANUAL_AUTHORIZATION:\s*\$\{\{\s*inputs\.authorization\s*\}\}\s*$/mu, name);
    }
});

test('workflow event extraction ignores comments and nested dispatch inputs', () => {
    const workflow = 'on:\n  # push:\n  workflow_dispatch:\n    inputs:\n      schedule:\n        required: true\npermissions:\n  contents: read\n';
    assert.deepEqual([...readWorkflowEvents(workflow)], ['workflow_dispatch']);
    assert.throws(() => readWorkflowEvents('name: missing events\njobs: {}\n'), /top-level event mapping/u);
    assert.throws(() => readWorkflowEvents('on:\n  # push:\njobs: {}\n'), /empty or unsupported/u);
});

test('manual workflow documentation rejects unsupported push claims', () => {
    const events = new Set(['workflow_dispatch']);
    for (const claim of ['CI runs automatically on push.', 'SBOM starts on every push.', '- every push of a version tag (`v*`);']) {
        assert.deepEqual(unsupportedTriggerClaims(claim, events), ['push'], claim);
    }
    assert.deepEqual(unsupportedTriggerClaims('This checkout still contains automatic push/PR triggers in ci.yml.', events), ['push', 'pull_request']);
});

test('manual workflow documentation rejects unsupported pull-request claims', () => {
    for (const claim of ['CI runs on pull_request.', 'CI runs on pull-request.', 'Security scans run on every pull request.', '- every pull request targeting dev;']) {
        assert.deepEqual(unsupportedTriggerClaims(claim, new Set(['workflow_dispatch'])), ['pull_request'], claim);
    }
});

test('manual workflow documentation rejects unsupported scheduled claims', () => {
    for (const claim of ['CI runs nightly.', 'SBOM is generated daily.', 'Secret Scanning runs on a schedule.']) {
        assert.deepEqual(unsupportedTriggerClaims(claim, new Set(['workflow_dispatch'])), ['schedule'], claim);
    }
});

test('documentation contract accepts manual policy and events actually configured', () => {
    const manual = 'CI accepts only explicitly authorized `workflow_dispatch`. Pushing a tag starts no run. Existing automatic push/PR triggers in a fork must be reconciled before uploading.';
    assert.deepEqual(unsupportedTriggerClaims(manual, new Set(['workflow_dispatch'])), []);
    const configured = readWorkflowEvents('on:\n  workflow_dispatch:\n  push:\n  pull_request:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}\n');
    assert.deepEqual(unsupportedTriggerClaims('CI runs on push. CI runs on pull_request. CI runs nightly.', configured), []);
});

test('current documentation matches authorized workflow triggers', () => {
    const failures: string[] = [];
    for (const [document, names] of documentWorkflows) {
        const content = readRepoFile(document);
        if (!content.includes('workflow_dispatch') || !/authoriz/iu.test(content)) failures.push(`${document}: missing manual dispatch or authorization explanation`);
        for (const name of names) {
            const events = readWorkflowEvents(readRepoFile(`.github/workflows/${name}.yml`));
            for (const event of unsupportedTriggerClaims(content, events)) failures.push(`${document}: unsupported ${event} claim for ${name}.yml`);
        }
    }
    assert.deepEqual(failures, []);
});

test('standard test command includes the owning documentation contract directory', () => {
    const manifest = JSON.parse(readRepoFile('package.json')) as { scripts: { test: string } };
    assert.match(manifest.scripts.test, /^node scripts\/node-foundation\/build-scripts\.cjs test\.js /u);
    assert.match(manifest.scripts.test, /(?:^|\s)tests\/node\/docs(?:\s|$)/u);
});
