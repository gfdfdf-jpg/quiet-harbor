import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readRepoFile(relativePath: string): string {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('task test selection docs invalidate production changes and retain only equivalent preflight refreshes', () => {
    for (const relativePath of ['docs/cli-reference.md', 'template/skills/orchestration/SKILL.md']) {
        const content = readRepoFile(relativePath);
        assert.match(content, /Unchanged workspace scope and content retain the selection across equivalent preflight refreshes/u, relativePath);
        assert.match(content, /[Pp]roduction or test changes, changed targets(?:,)? or a new task cycle require/u, relativePath);
        assert.doesNotMatch(content, /unchanged test scope|changed tests or a new task cycle/iu, relativePath);
    }
});

test('compile-gate docs and templates pin workflow-config fail-closed contract', () => {
    const surfaces = [
        'docs/cli-reference.md',
        'docs/control-plane-isolation.md',
        'docs/task-plan-workflow.md',
        'template/docs/agent-rules/40-commands.md',
        'template/docs/agent-rules/90-skill-catalog.md',
        'template/skills/orchestration/SKILL.md'
    ] as const;

    for (const relativePath of surfaces) {
        const content = readRepoFile(relativePath);
        assert.doesNotMatch(content, /--commands-path/u, `${relativePath} must not document legacy compile-gate command discovery`);
        assert.doesNotMatch(content, /fallback[^.\n]*40-commands\.md|40-commands\.md[^.\n]*fallback/iu, `${relativePath} must not document a 40-commands.md fallback`);
    }

    assert.match(
        readRepoFile('docs/cli-reference.md'),
        /garda gate compile-gate --task-id "T-001" --preflight-path "garda-agent-orchestrator\/runtime\/reviews\/T-001-preflight\.json"/u
    );
    assert.match(
        readRepoFile('docs/cli-reference.md'),
        /Missing values or `__COMPILE_GATE_COMMAND_UNCONFIGURED__` fail closed/u
    );
    assert.match(
        readRepoFile('docs/task-plan-workflow.md'),
        /node bin\/garda\.js gate compile-gate[\s\S]*--preflight-path "garda-agent-orchestrator\/runtime\/reviews\/T-048-preflight\.json"/u
    );
    assert.match(
        readRepoFile('template/docs/agent-rules/40-commands.md'),
        /node garda-agent-orchestrator\/bin\/garda\.js gate compile-gate --task-id "<task-id>" --preflight-path "garda-agent-orchestrator\/runtime\/reviews\/<task-id>-preflight\.json"/u
    );
    assert.match(
        readRepoFile('template/docs/agent-rules/40-commands.md'),
        /`compile_gate\.command` is the executable compile-gate command/u
    );
    assert.match(
        readRepoFile('template/docs/agent-rules/90-skill-catalog.md'),
        /node garda-agent-orchestrator\/bin\/garda\.js gate compile-gate --task-id "<task-id>" --preflight-path "garda-agent-orchestrator\/runtime\/reviews\/<task-id>-preflight\.json"/u
    );
    assert.match(
        readRepoFile('template/skills/orchestration/SKILL.md'),
        /node garda-agent-orchestrator\/bin\/garda\.js gate compile-gate --task-id "<task-id>" --preflight-path "garda-agent-orchestrator\/runtime\/reviews\/<task-id>-preflight\.json"/u
    );
});
