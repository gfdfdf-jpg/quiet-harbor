import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export interface ReceiptRegistryFixture {
    packageSpec: string;
    version: string;
    integrity: string;
    packageRoot: string;
}

export interface ReceiptRegistryOptions {
    initialMetadataIntegrity?: string;
}

// A separate process serves synchronous npm view without blocking its own registry.
const REGISTRY_SERVER = `
const http = require('node:http');
const fs = require('node:fs');
const [packagePath, tarballPath, integrity, initialMetadataIntegrity] = process.argv.slice(1);
const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const tarball = fs.readFileSync(tarballPath);
let metadataRequests = 0;
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/fixture.tgz') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(tarball);
    }
    if (pathname !== '/' + metadata.name) {
        response.writeHead(404);
        return response.end('{}');
    }
    const resolvedIntegrity = ++metadataRequests === 1 && initialMetadataIntegrity ? initialMetadataIntegrity : integrity;
    const version = { ...metadata, dist: { integrity: resolvedIntegrity,
        tarball: 'http://127.0.0.1:' + server.address().port + '/fixture.tgz' } };
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ name: metadata.name,
        'dist-tags': { latest: metadata.version }, versions: { [metadata.version]: version } }));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('disconnect', () => server.close(() => process.exit(0)));
`;

function isNpmEnvironmentKey(key: string): boolean {
    return key.toUpperCase().startsWith('NPM_CONFIG_')
        || ['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key.toUpperCase());
}

function clearNpmEnvironment(): void {
    for (const key of Object.keys(process.env).filter(isNpmEnvironmentKey)) delete process.env[key];
}

export async function withReceiptRegistry<T>(packageRoot: string,
    run: (registry: ReceiptRegistryFixture) => Promise<T>, options: ReceiptRegistryOptions = {}): Promise<T> {
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-receipt-registry-'));
    const inherited = Object.entries(process.env).filter(([key]) => isNpmEnvironmentKey(key));
    let server: ReturnType<typeof spawn> | undefined;
    try {
        clearNpmEnvironment();
        for (const config of ['user', 'global']) fs.writeFileSync(path.join(registryRoot, `${config}.npmrc`), '');
        Object.assign(process.env, {
            npm_config_userconfig: path.join(registryRoot, 'user.npmrc'),
            npm_config_globalconfig: path.join(registryRoot, 'global.npmrc'),
            npm_config_cache: path.join(registryRoot, 'cache'),
            npm_config_registry: 'http://127.0.0.1:9', npm_config_offline: 'false',
            npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
            npm_config_update_notifier: 'false', npm_config_fetch_retries: '0'
        });
        const npmCli = [process.env.npm_execpath,
            path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
            path.resolve(path.dirname(process.execPath), '../node_modules/npm/bin/npm-cli.js')]
            .find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
        assert.ok(npmCli, 'The native npm CLI must be available for receipt provenance fixtures.');
        const packed = spawnSync(process.execPath,
            [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', registryRoot],
            { cwd: packageRoot, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
        assert.equal(packed.error, undefined);
        assert.equal(packed.status, 0, `${packed.stderr}\n${packed.stdout}`);
        const filename = JSON.parse(packed.stdout)[0].filename as string;
        assert.equal(path.basename(filename), filename);
        const tarball = path.join(registryRoot, filename);
        const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
        const metadataPath = path.join(packageRoot, 'package.json');
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        assert.equal(metadata.name, 'garda-agent-orchestrator');
        assert.equal(Object.keys(metadata.dependencies || {}).length, 0);
        server = spawn(process.execPath, ['-e', REGISTRY_SERVER, metadataPath, tarball, integrity,
            options.initialMetadataIntegrity || ''],
            { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const child = server;
        let serverErrors = '';
        child.stderr?.on('data', chunk => { serverErrors += String(chunk); });
        const port = await new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Receipt registry startup timed out.')), 10_000);
            const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
            child.once('error', fail);
            child.once('exit', code => fail(new Error(`Receipt registry exited ${code}: ${serverErrors}`)));
            child.once('message', message => {
                clearTimeout(timeout);
                const value = (message as { port: number }).port;
                if (!Number.isInteger(value) || value <= 0) return reject(new Error('Invalid registry port.'));
                resolve(value);
            });
        });
        process.env.npm_config_registry = `http://127.0.0.1:${port}`;
        return await run({ packageSpec: `${metadata.name}@${metadata.version}`,
            version: metadata.version, integrity, packageRoot });
    } finally {
        if (server && server.exitCode === null && server.signalCode === null) {
            const child = server;
            await new Promise<void>(resolve => {
                child.once('exit', () => resolve());
                child.kill();
            });
        }
        clearNpmEnvironment();
        for (const [key, value] of inherited) process.env[key] = value;
        assert.equal(path.dirname(registryRoot), path.resolve(os.tmpdir()));
        fs.rmSync(registryRoot, { recursive: true, force: true });
    }
}
