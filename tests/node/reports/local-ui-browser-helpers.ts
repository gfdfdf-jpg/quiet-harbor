import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function findLocalAcceptanceBrowser(): string | undefined {
    return [process.env.GARDA_BROWSER_EXECUTABLE,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium'].find(file => file && fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

export async function openLocalAcceptanceBrowser(executable: string, profile: string, origins: readonly string[]) {
    const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-proxy-server',
        '--host-resolver-rules=MAP rebind.invalid 127.0.0.1, EXCLUDE 127.0.0.1, MAP * ~NOTFOUND',
        '--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    let launchError: Error | undefined;
    child.on('error', error => { launchError = error; });
    let socket: WebSocket | undefined;
    let sessionId: string | undefined;
    let nextId = 0;
    let interceptionError: unknown;
    const networkFailures: string[] = [];
    let loaded: (() => void) | undefined;
    const pending = new Map<number, {
        resolve: (result: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    const command = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
            if (socket?.readyState !== WebSocket.OPEN) return reject(new Error('Browser transport is not open.'));
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 6000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params, ...(method.startsWith('Browser.') ? {} : { sessionId }) }));
        });
    const close = async (): Promise<void> => {
        const exited = new Promise<void>((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null || (launchError && child.pid === undefined)) return resolve();
            const terminate = setTimeout(() => { child.kill(); }, 3000);
            const deadline = setTimeout(() => { clearTimeout(terminate); reject(new Error('Fixture browser did not exit.')); }, 6000);
            child.once('exit', () => { clearTimeout(terminate); clearTimeout(deadline); resolve(); });
        });
        if (socket?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => undefined);
        else child.kill();
        await exited;
        socket?.close();
    };
    try {
        const portFile = path.join(profile, 'DevToolsActivePort');
        // A busy hosted runner can take more than 10 s to start Chrome and publish the endpoint file.
        const deadline = Date.now() + 20000;
        let contents: string;
        while (true) {
            try {
                contents = fs.readFileSync(portFile, 'utf8');
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                // Chrome can create the endpoint file before Windows allows another process to open it.
                if (code !== 'ENOENT' && !(process.platform === 'win32' && (code === 'EBUSY' || code === 'EPERM'))) throw error;
                if (launchError) throw launchError;
                const remaining = deadline - Date.now();
                if (child.exitCode !== null || remaining <= 0) throw new Error('Installed browser did not publish its fixture endpoint.', { cause: error });
                await delay(Math.min(25, remaining));
            }
        }
        const [port, endpoint] = contents.trim().split(/\r?\n/u);
        if (!/^\d{1,5}$/u.test(port) || Number(port) > 65535 || !/^\/devtools\/browser\/[a-f0-9-]+$/u.test(endpoint)) {
            throw new Error('Browser fixture endpoint is invalid.');
        }
        socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Browser transport did not open.')), 6000);
            socket!.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
            socket!.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser transport failed.')); }, { once: true });
        });
        socket.addEventListener('close', () => {
            for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser transport closed.')); }
            pending.clear();
        });
        socket.addEventListener('message', event => {
            const message = JSON.parse(String(event.data));
            const item = pending.get(message.id);
            if (item) {
                clearTimeout(item.timer); pending.delete(message.id);
                if (message.error) item.reject(new Error(`Browser command rejected: ${message.error.message}`));
                else item.resolve(message.result || {});
            } else if (message.method === 'Page.loadEventFired') loaded?.();
            else if (message.method === 'Network.loadingFailed') networkFailures.push(JSON.stringify({
                error: message.params.errorText, blocked: message.params.blockedReason, cors: message.params.corsErrorStatus }));
            else if (message.method === 'Fetch.requestPaused') {
                const allowed = origins.includes(new URL(message.params.request.url).origin);
                void command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
                    requestId: message.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' })
                }).catch(error => { interceptionError = error; });
            }
        });
        const version = await command('Browser.getVersion');
        const target = await command('Target.createTarget', { url: 'about:blank' });
        const attached = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        sessionId = String(attached.sessionId);
        await command('Page.enable');
        await command('Runtime.enable');
        await command('Network.enable');
        await command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        return {
            version,
            networkFailures,
            close,
            navigate: async (url: string) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const ready = new Promise<void>((resolve, reject) => {
                    loaded = resolve;
                    timer = setTimeout(() => reject(new Error('Browser fixture page did not load.')), 6000);
                });
                try { await Promise.all([command('Page.navigate', { url }), ready]); }
                finally { clearTimeout(timer); loaded = undefined; }
            },
            evaluate: async <T>(expression: string): Promise<T> => {
                const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
                const exception = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
                const failure = exception?.exception?.description || exception?.text || (interceptionError ? String(interceptionError) : '');
                if (failure) throw new Error(`Browser fixture failed: ${failure.split('\n')[0].replace(/[a-f0-9]{64}/gu, '[redacted]')}`);
                return (result.result as { value: T }).value;
            }
        };
    } catch (error) {
        await close();
        throw error;
    }
}
