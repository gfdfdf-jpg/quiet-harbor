import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NativeWalkOwner, waitForOwner } from './walk-native-owner';

interface DebugMessage {
    id?: number;
    method?: string;
    result?: Record<string, unknown>;
    error?: { message: string };
    params?: { hitBreakpoints?: string[] };
}

/** Use the runtime debugger to interrupt unmodified native code after one durable publication. */
export async function interruptPublication(owner: NativeWalkOwner, modulePath: string, statement: string): Promise<string> {
    const lines = fs.readFileSync(modulePath, 'utf8').split(/\r?\n/u);
    const matches = lines.flatMap((line, index) => line.includes(statement) ? [index] : []);
    if (matches.length !== 1) throw new Error('Publication boundary must match exactly one compiled statement: ' + statement);
    await waitForOwner('native inspector endpoint', () => {
        owner.assertRunning();
        return /Debugger listening on (ws:\/\/\S+)/u.test(owner.output);
    }, 30_000);
    const url = /Debugger listening on (ws:\/\/\S+)/u.exec(owner.output)![1];
    const socket = new WebSocket(url);
    let opened = false;
    let failure: Error | undefined;
    let nextId = 0;
    const responses = new Map<number, DebugMessage>();
    const pauses: DebugMessage[] = [];
    socket.addEventListener('open', () => { opened = true; });
    socket.addEventListener('error', () => { failure = new Error('Native inspector connection failed.'); });
    socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as DebugMessage;
        if (message.id) responses.set(message.id, message);
        if (message.method === 'Debugger.paused') pauses.push(message);
    });
    const check = () => { if (failure) throw failure; owner.assertRunning(); };
    const request = async (method: string, params = {}): Promise<Record<string, unknown>> => {
        const id = ++nextId;
        socket.send(JSON.stringify({ id, method, params }));
        await waitForOwner(method + ' response', () => { check(); return responses.has(id); }, 30_000);
        const message = responses.get(id)!;
        responses.delete(id);
        if (message.error) throw new Error(method + ': ' + message.error.message);
        return message.result ?? {};
    };
    try {
        await waitForOwner('inspector WebSocket open', () => { check(); return opened; }, 30_000);
        await request('Debugger.enable');
        const breakpoint = await request('Debugger.setBreakpointByUrl', {
            url: pathToFileURL(modulePath).href, lineNumber: matches[0], columnNumber: 0
        });
        await request('Runtime.runIfWaitingForDebugger');
        await waitForOwner('native initial debugger pause', () => { check(); return pauses.length > 0; }, 30_000);
        pauses.shift();
        await request('Debugger.resume');
        await waitForOwner('native publication breakpoint', () => { check(); return pauses.length > 0; });
        const pause = pauses.shift()!;
        if (!pause.params?.hitBreakpoints?.includes(String(breakpoint.breakpointId)))
            throw new Error('Native owner paused somewhere other than the declared publication boundary.');
        // The debugger executes a real self SIGKILL while the main thread is paused. No finally
        // handler or evidence rollback runs, and no production module or artifact is modified.
        socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.evaluate',
            params: { expression: 'process.kill(process.pid, "SIGKILL")' } }));
        await waitForOwner('interrupted publication owner exit', () => owner.closed, 30_000);
        return statement + ' (compiled line ' + (matches[0] + 1) + ')';
    } finally {
        socket.close();
    }
}
