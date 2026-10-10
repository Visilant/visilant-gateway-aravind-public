import 'reflect-metadata';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AuthService } from '../src/application/services';
import { AddressInfo } from 'net';
import type { Server } from 'http';
import Container from 'typedi';
import { DataSource } from 'typeorm';
import { GatewayConfig } from '../src/config';
import { CONFIG, DATABASE, LOGGER, RECORDER } from '../src/tokens';
import { GatewayServer } from '../src/presentation/server';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { DiagnosticRecorder } from '../src/infrastructure/diagnostics';

let server: Server, database: DataSource, base: string, directory: string, recorder: DiagnosticRecorder;
beforeAll(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:')); await database.initialize(); await database.runMigrations();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-routes-'));
    Container.set(CONFIG, Object.assign(new GatewayConfig(), { listen_port: 0, storage_root: directory }));
    Container.set(AuthService, { authenticate: async (header: string) => header === 'Bearer test' ? { id: 'test' } : null } as never);
    Container.set(DATABASE, database); recorder = new DiagnosticRecorder(); Container.set(RECORDER, recorder);
    Container.set(LOGGER, { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never);
    server = await Container.get(GatewayServer).start(); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await recorder.stop(); await database.destroy(); Container.reset(); await fs.rm(directory, { recursive: true, force: true }); });
test.each(['/ui', '/ui/'])('%s serves HTML', async path => { const r = await fetch(base + path); expect(r.status).toBe(200); expect(r.headers.get('content-type')).toMatch(/^text\/html/); expect(await r.text()).toContain('Visilant Gateway'); });
test.each([['/ui/app.js', /javascript/], ['/ui/app.css', /text\/css/]])('%s serves a static asset', async (path, mime) => { const r = await fetch(base + path); expect(r.status).toBe(200); expect(r.headers.get('content-type')).toMatch(mime); });
test('unknown static path returns the JSON 404', async () => { const r = await fetch(base + '/ui/nope.js'); expect(r.status).toBe(404); expect(await r.json()).toEqual({ error: 'not found' }); });
test.each(['/captures', '/diagnostics', '/system/config', '/system/device', '/captures/00000000-0000-0000-0000-000000000000/preview', '/diagnostics/segments/00000000-0000-0000-0000-000000000000/archive'])('%s requires authentication', async path => { expect((await fetch(base + path)).status).toBe(401); });

test('a ZIP stream reaches the client without falling through to the 404 handler', async () => {
    await recorder.start(path.join(directory, 'diagnostics'));
    const id = recorder.segmentId!;
    const res = await fetch(base + `/diagnostics/segments/${id}/archive`, { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bytes = Buffer.from(await res.arrayBuffer()); expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect((await fetch(base + '/ui')).status).toBe(200);
});

test('setup progress is private and completion cannot be asserted without observed delivery', async () => {
    const prior = process.env.GATEWAY_SETUP_TOKEN;
    try {
        delete process.env.GATEWAY_SETUP_TOKEN;
        expect((await fetch(base + '/setup-progress')).status).toBe(401);
        process.env.GATEWAY_SETUP_TOKEN = 'test-private-bridge';
        expect((await fetch(base + '/setup-progress', { headers: { Authorization: 'Bearer test' } })).status).toBe(401);
        const headers = { 'x-setup-token': 'test-private-bridge', 'content-type': 'application/json' };
        const begin = await fetch(base + '/setup-progress/begin', { method: 'POST', headers, body: '{}' });
        expect(begin.status).toBe(200);
        expect(await begin.json()).toMatchObject({ data: { received: 0, sent: 0, started_at: expect.any(String) } });
        const incomplete = await fetch(base + '/setup-progress/complete', { method: 'POST', headers,
            body: JSON.stringify({ synthetic: true, viewer: true, startup: true }) });
        expect(incomplete.status).toBe(400);
        expect(await incomplete.json()).toMatchObject({ error: 'The test is not complete.', missing: expect.arrayContaining(['phone_signin', 'worklist', 'pacs_delivery']) });
        const unticked = await fetch(base + '/setup-progress/complete', { method: 'POST', headers,
            body: JSON.stringify({ synthetic: true, viewer: true, startup: false }) });
        const unticked_body = await unticked.json() as { missing: string[] };
        expect(unticked.status).toBe(400);
        expect(unticked_body.missing).toContain('startup_confirmation');
        expect(unticked_body.missing).not.toContain('synthetic_confirmation');
        const absent = await fetch(base + '/setup-progress/complete', { method: 'POST', headers, body: JSON.stringify({ synthetic: true, viewer: true }) });
        expect(absent.status).toBe(400);
        expect(JSON.stringify(await absent.json())).not.toMatch(/token|synthetic_confirmation\b.*startup/);
    } finally { if (prior === undefined) delete process.env.GATEWAY_SETUP_TOKEN; else process.env.GATEWAY_SETUP_TOKEN = prior; }
});
