import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startLocalUiServer } from '../../../src/reports/ui/local-ui-server';
import { findLocalAcceptanceBrowser, openLocalAcceptanceBrowser } from './local-ui-browser-helpers';
import { cleanupLocalUiTestResources, makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

test('T-206-2 native browser enforces local UI admission before protected effects', { timeout: 60000 }, async t => {
    const executable = findLocalAcceptanceBrowser();
    if (!executable) { t.skip('Native browser unavailable; this is not browser acceptance.'); return; }
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const taskPath = path.join(repoRoot, 'TASK.md');
    const originalTask = fs.readFileSync(taskPath, 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'browser.preview'), 'native browser preview');
    let actions = 0;
    const disabledUpdate = () => ({ status: 'disabled' as const, currentVersion: null, latestVersion: null, updateCommand: null });
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true, idleShutdownEnabled: false,
        updateAvailabilityService: { snapshot: disabledUpdate, check: async () => disabledUpdate() },
        actionRunner: async () => { actions += 1; return { exit_code: 0, signal: null, stdout: 'fixture', stderr: '' }; } });
    const hostile = http.createServer((_request, response) => { response.end('<!doctype html><p>Hostile-origin fixture</p>'); });
    let browser: Awaited<ReturnType<typeof openLocalAcceptanceBrowser>> | undefined;
    let taskReads = 0;
    const observations: Array<{ method: string; path: string; host: string; origin: string; status: number }> = [];
    server.server.prependListener('request', (request, response) => {
        response.once('finish', () => observations.push({ method: request.method || '',
            path: (request.url || '').split('?')[0], host: request.headers.host || '',
            origin: String(request.headers.origin || ''), status: response.statusCode }));
    });
    try {
        hostile.listen(0, '127.0.0.1');
        await once(hostile, 'listening');
        const hostileOrigin = `http://127.0.0.1:${(hostile.address() as import('node:net').AddressInfo).port}`;
        const canonicalOrigin = server.url.slice(0, -1);
        const controlledOrigin = `http://rebind.invalid:${server.port}`;
        browser = await openLocalAcceptanceBrowser(executable, path.join(repoRoot, 'browser-profile'),
            [canonicalOrigin, hostileOrigin, controlledOrigin]);
        t.diagnostic(JSON.stringify({ browser: browser.version.product, userAgent: browser.version.userAgent,
            os: `${os.platform()} ${os.release()}`, node: process.version, canonicalOrigin, hostileOrigin,
            controlledOrigin, dnsAnswerTransition: 'not exercised; static hostname mapping only' }));
        await browser.navigate(`${canonicalOrigin}/browser-fixture`);
        assert.equal(await browser.evaluate('location.origin'), canonicalOrigin, 'the probe must use the canonical document origin');
        const originalRead = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
            if (String(args[0]) === taskPath) taskReads += 1;
            return originalRead(...args);
        });
        const legitimate = await browser.evaluate<{
            page: number; token: boolean; report: number; preview: number; text: string; action: number;
            nosniff: string; frame: string; resourcePolicy: string;
        }>(`(async () => {
            const page = await fetch('/'); const html = await page.text();
            const token = html.match(/const actionToken = "([a-f0-9]{64})";/)?.[1];
            globalThis.fixtureToken = token;
            const report = await fetch('/api/report'); await report.text();
            const preview = await fetch('/files?path=browser.preview&action_token=' + token);
            const text = await preview.text();
            const action = await fetch('/api/actions', { method: 'POST',
                headers: { 'content-type': 'application/json', 'x-garda-action-token': token },
                body: JSON.stringify({ action_id: 'status', mode: 'execute' }) });
            await action.text();
            return { page: page.status, token: !!token, report: report.status, preview: preview.status, text,
                action: action.status, nosniff: page.headers.get('x-content-type-options'),
                frame: page.headers.get('x-frame-options'), resourcePolicy: page.headers.get('cross-origin-resource-policy') };
        })()`);
        assert.deepEqual(legitimate, { page: 200, token: true, report: 200, preview: 200,
            text: 'native browser preview', action: 200, nosniff: 'nosniff', frame: 'DENY', resourcePolicy: 'same-origin' });
        assert.ok(taskReads > 0, 'the positive report must reach the instrumented workspace');
        assert.equal(actions, 1, 'the authorized browser POST must reach the fixture runner');
        taskReads = 0;
        const invalidToken = await browser.evaluate<number>(`(async () => {
            const response = await fetch('/api/tasks/T-100/actions', { method: 'POST',
                headers: { 'content-type': 'application/json', 'x-garda-action-token': 'foreign' }, body: '{}' });
            await response.text(); return response.status;
        })()`);
        assert.equal(invalidToken, 403);
        assert.equal(taskReads, 0);
        assert.equal(actions, 1);
        await browser.navigate(hostileOrigin);
        observations.length = 0;
        const hostileResult = await browser.evaluate<{ read: string; post: string }>(`(async () => {
            const target = ${JSON.stringify(canonicalOrigin)};
            const read = await fetch(target + '/api/report').then(() => 'readable', () => 'blocked');
            const post = await fetch(target + '/api/tasks/T-100/actions', { method: 'POST', mode: 'no-cors',
                headers: { 'content-type': 'text/plain' }, body: '{}' }).then(r => r.type, () => 'blocked');
            return { read, post };
        })()`);
        assert.deepEqual(hostileResult, { read: 'blocked', post: 'blocked' });
        assert.ok(browser.networkFailures.some(failure => JSON.parse(failure).blocked === 'corp-not-same-origin'),
            'the hostile POST response must retain the native same-origin resource policy');
        for (const [method, endpoint] of [['GET', '/api/report'], ['POST', '/api/tasks/T-100/actions']]) {
            assert.ok(observations.some(item => item.method === method && item.path === endpoint
                && item.origin === hostileOrigin && item.status === 403), `${method} must actually reach and be rejected by Garda`);
        }
        assert.equal(taskReads, 0, 'hostile requests must not build a task report');
        assert.equal(actions, 1, 'hostile requests must not execute an action');
        await browser.navigate(controlledOrigin);
        assert.deepEqual(await browser.evaluate(`({ denied: document.body.textContent.includes('Request rejected'),
            tokenExposed: document.body.textContent.includes('actionToken') })`), { denied: true, tokenExposed: false });
        assert.ok(observations.some(item => item.host === `rebind.invalid:${server.port}` && item.status === 403));
        assert.equal(taskReads, 0);
        assert.equal(actions, 1);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), originalTask);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'browser.preview'), 'utf8'), 'native browser preview');
    } catch (error) {
        t.diagnostic(`Browser network diagnostics: ${JSON.stringify(browser?.networkFailures || [])}`);
        t.diagnostic(`Server observations: ${JSON.stringify(observations)}`);
        throw error;
    } finally {
        t.mock.restoreAll();
        try { await browser?.close(); }
        finally {
            hostile.closeAllConnections();
            if (hostile.listening) await new Promise<void>((resolve, reject) => hostile.close(error => error ? reject(error) : resolve()));
            await cleanupLocalUiTestResources({ repoRoot, server });
        }
    }
});
