import { DefaultSerializer } from 'node:v8';
import { AsyncLocalStorage } from 'node:async_hooks';

const serializer = new DefaultSerializer();
serializer.writeHeader();
const header = serializer.releaseBuffer();
const outputCapture = new AsyncLocalStorage<string[]>();

/** Node's test child sends framed V8 messages over stdout. They are harness data, not gate output. */
export function isTestProtocolFrame(chunk: unknown): chunk is Buffer {
    if (!Buffer.isBuffer(chunk) || chunk.length < header.length * 2 + 4) return false;
    const offset = header.length + 4;
    return chunk.subarray(0, header.length).equals(header)
        && chunk.readUInt32BE(header.length) === chunk.length - offset
        && chunk.subarray(offset, offset + header.length).equals(header);
}

export function captureWalkOutput<T>(capture: string[], action: () => Promise<T>): Promise<T> {
    const originalLog = console.log, originalError = console.error, originalWarn = console.warn;
    const originalStdout = process.stdout.write, originalStderr = process.stderr.write;
    const record = (original: typeof console.log) => (...values: unknown[]) => {
        if (outputCapture.getStore() !== capture) { Reflect.apply(original, console, values); return; }
        capture.push(values.map(String).join(' '));
    };
    const writer = (stream: NodeJS.WriteStream, original: typeof process.stdout.write) =>
        (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean => {
            if (outputCapture.getStore() !== capture || isTestProtocolFrame(chunk)) {
                return Reflect.apply(original, stream, [chunk, encodingOrCallback, callback]);
            }
            capture.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
            const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
            if (typeof done === 'function') queueMicrotask(() => { done(); });
            return true;
        };
    console.log = record(originalLog); console.error = record(originalError); console.warn = record(originalWarn);
    process.stdout.write = writer(process.stdout, originalStdout) as typeof process.stdout.write;
    process.stderr.write = writer(process.stderr, originalStderr) as typeof process.stderr.write;
    const restore = () => {
        console.log = originalLog; console.error = originalError; console.warn = originalWarn;
        process.stdout.write = originalStdout; process.stderr.write = originalStderr;
    };
    try { return outputCapture.run(capture, action).finally(restore); }
    catch (error) { restore(); throw error; }
}
