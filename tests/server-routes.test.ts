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
import { DiagnosticRecorder, diagnostics } from '../src/infrastructure/diagnostics';
import { WorklistClient } from '../src/infrastructure/dicom';

let server: Server, database: DataSource, base: string, directory: string, recorder: DiagnosticRecorder;
beforeAll(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:')); await database.initialize(); await database.runMigrations();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-routes-'));
    Container.set(CONFIG, Object.assign(new GatewayConfig(), { listen_port: 0, storage_root: directory,
        mwl: { host: 'synthetic', port: 104, called_ae: 'MWL', calling_ae: 'GATEWAY' } }));
    Container.set(AuthService, { authenticate: async (header: string) => header === 'Bearer test' ? { id: 'test', role: 'OPERATOR' } :
        header === 'Bearer admin' ? { id: 'admin', role: 'ADMIN' } : null } as never);
    Container.set(WorklistClient, { query: async () => [{ '00100020': { vr: 'LO', Value: ['CANARY-PATIENT-ID'] },
        '00100010': { vr: 'PN', Value: [{ Alphabetic: 'CANARY^NAME' }] } }] } as never);
    Container.set(DATABASE, database); recorder = diagnostics; Container.set(RECORDER, recorder);
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

test('worklist diagnosis is authenticated, read-only, correlated and contains no patient values', async () => {
    for (const route of ['/diagnostics/worklist', '/diagnostics/worklist/settings', '/diagnostics/worklist/support']) {
        expect((await fetch(base + route)).status).toBe(401);
    }
    const headers = { Authorization: 'Bearer test' };
    expect((await fetch(base + '/diagnostics/worklist/check', { method: 'POST' })).status).toBe(401);
    const response = await fetch(base + '/worklist', { headers });
    expect(await response.json()).toEqual({ data: [] });
    const correlation = response.headers.get('x-diagnostic-request-id');
    expect(correlation).toMatch(/^[a-f0-9-]{36}$/);
    const report = await fetch(base + '/diagnostics/worklist', { headers });
    expect(report.headers.get('cache-control')).toBe('no-store');
    const body = await report.json() as { data: { checks: unknown[] } };
    expect(body.data.checks[0]).toMatchObject({ request_id: correlation, source: 'worklist_request', counts: { missing_accession: 1, returned_rows: 0 } });
    const support = await fetch(base + '/diagnostics/worklist/support', { headers });
    expect(support.headers.get('content-disposition')).toContain('gateway-worklist-support.json');
    expect(support.headers.get('cache-control')).toBe('no-store');
    expect(await support.text()).not.toMatch(/CANARY|synthetic|storage_root|authorization|database_path/);
});

test('only admins can preview and change filters; malformed and stale saves cannot apply', async () => {
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    const operator = { ...admin, Authorization: 'Bearer test' };
    const snapshot = async () => (await (await fetch(base + '/diagnostics/worklist/settings', { headers: admin })).json() as { data: { revision: string; filters: unknown } }).data;
    const before = await snapshot();
    const filters = { requested_procedure_id: '', modality: '', scheduled_station_ae: 'VISILANT' };
    for (const [path, method, body] of [
        ['/preview', 'POST', filters], ['/settings', 'PUT', { ...filters, revision: before.revision }],
        ['/settings/reset', 'POST', { ...filters, revision: before.revision }],
    ] as const) {
        expect((await fetch(base + '/diagnostics/worklist' + path, { method, headers: operator, body: JSON.stringify(body) })).status).toBe(403);
    }
    const invalid = await fetch(base + '/diagnostics/worklist/settings', { method: 'PUT', headers: admin,
        body: JSON.stringify({ ...filters, modality: 'SENSITIVE-CANARY-TOO-LONG', revision: before.revision, arbitrary: 'value' }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('SENSITIVE-CANARY');
    expect(await snapshot()).toEqual(before);
    const preview = await fetch(base + '/diagnostics/worklist/preview', { method: 'POST', headers: admin, body: JSON.stringify(filters) });
    expect(preview.status).toBe(200);
    expect(await snapshot()).toEqual(before);
    const saved = await fetch(base + '/diagnostics/worklist/settings', { method: 'PUT', headers: admin, body: JSON.stringify({ ...filters, revision: before.revision }) });
    expect(saved.status).toBe(200);
    expect((await snapshot()).filters).toEqual(filters);
    expect((await fetch(base + '/diagnostics/worklist/settings', { method: 'PUT', headers: admin, body: JSON.stringify({ ...filters, revision: before.revision }) })).status).toBe(409);
});

test('incoming records require admin auth, are not cached, and never enter support reports or archives', async () => {
    await recorder.start(path.join(directory, 'diagnostics'));
    const route = base + '/diagnostics/worklist/inspect';
    expect((await fetch(route, { method: 'POST' })).status).toBe(401);
    expect((await fetch(route, { method: 'POST', headers: { Authorization: 'Bearer test' } })).status).toBe(403);
    const response = await fetch(route, { method: 'POST', headers: { Authorization: 'Bearer admin' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { data: { records: { dicom_json: string; candidates: unknown[] }[] } };
    expect(body.data.records[0].dicom_json).toContain('CANARY-PATIENT-ID');
    expect(body.data.records[0].candidates[0]).toMatchObject({ outcome: 'missing_accession' });
    for (const suffix of ['', '/support']) {
        const summary = await fetch(base + '/diagnostics/worklist' + suffix, { headers: { Authorization: 'Bearer admin' } });
        expect(await summary.text()).not.toMatch(/CANARY|dicom_json|effective_study_uid/);
    }
    await recorder.flush();
    const files = await fs.readdir(path.join(directory, 'diagnostics', recorder.segmentId!));
    const contents = (await Promise.all(files.map(file => fs.readFile(path.join(directory, 'diagnostics', recorder.segmentId!, file), 'utf8')))).join('\n');
    expect(contents).toContain('worklist.explanation');
    expect(contents).not.toMatch(/CANARY|dicom_json|effective_study_uid/);
});

test('phone diagnostics routes require auth, validate DTOs without echoing rejected values, and serve detail and zip archives', async () => {
    const device = '11111111-2222-4333-8444-555555555555';
    const batch = '66666666-7777-4888-9999-aaaaaaaaaaaa';
    const crashId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    for (const [route, method] of [
        ['/diagnostics/phones', 'GET'],
        [`/diagnostics/phones/${device}`, 'GET'],
        [`/diagnostics/phones/${device}/archive`, 'GET'],
        ['/diagnostics/phones/events', 'POST'],
    ] as const) {
        expect((await fetch(base + route, { method })).status).toBe(401);
    }

    const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
    const validBatch = {
        device_id: device,
        batch_id: batch,
        manufacturer: 'Synthetic',
        device_model: 'Pixel Test',
        android_version: '14',
        api_level: 34,
        app_version: '2.1.0',
        model_revision: 'eye-2026.10',
        status: { battery_level: 85, charging: true, wifi_connected: true, seeker_connected: true, seeker_generation: 2 },
        events: [
            { stream: 'events', name: 'capture.burst', sequence: 1, utc_ms: 1700000000000, monotonic_ms: 1000, duration_ms: 45, outcome: 'ok', attributes: { trigger: 'auto', shot_count: 5, quality_score: 120, patient_name: 'CANARY^SECRET' } },
        ],
        crashes: [
            { crash_id: crashId, source: 'js', utc_ms: 1700000001000, error_type: 'TypeError', message: 'boom on patient CANARY^SECRET', stack: ['at Capture (file:///data/user/0/app/src/Capture.js:12:4)'], route: 'Capture' },
        ],
    };

    // Unknown top-level or nested keys are rejected with 400 and never echoed back.
    const rejected = await fetch(base + '/diagnostics/phones/events', {
        method: 'POST', headers, body: JSON.stringify({ ...validBatch, patient_name: 'CANARY-TOP-SECRET' }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain('CANARY-TOP-SECRET');

    const first = await fetch(base + '/diagnostics/phones/events', { method: 'POST', headers, body: JSON.stringify(validBatch) });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: { accepted_events: 1, accepted_crashes: 1, duplicate_batch: false } });

    const duplicate = await fetch(base + '/diagnostics/phones/events', { method: 'POST', headers, body: JSON.stringify(validBatch) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ data: { accepted_events: 0, accepted_crashes: 0, duplicate_batch: true } });

    const list = await fetch(base + '/diagnostics/phones', { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ data: { phones: [{ device_id: device, counts: { events: 1, crashes: 1, captures_taken: 5 } }] } });

    const detail = await fetch(base + `/diagnostics/phones/${device}`, { headers });
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain('CANARY');
    expect(JSON.parse(detailText)).toMatchObject({
        data: {
            phone: { device_id: device },
            crashes: [{ crash_id: crashId, message: 'boom on [redacted]', stack: ['at Capture (src/Capture.js:12:4)'] }],
            captures_and_models: { detector: { bursts_auto: 1, quality_score_p50: 120 } },
        },
    });

    expect((await fetch(base + '/diagnostics/phones/not-a-uuid', { headers })).status).toBe(400);
    expect((await fetch(base + '/diagnostics/phones/00000000-0000-4000-8000-000000000000', { headers })).status).toBe(404);
    expect((await fetch(base + '/diagnostics/phones/00000000-0000-4000-8000-000000000000/archive', { headers })).status).toBe(404);

    const zipRes = await fetch(base + `/diagnostics/phones/${device}/archive`, { headers });
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('content-type')).toBe('application/zip');
    expect(zipRes.headers.get('content-disposition')).toContain(`${device}.zip`);
    const bytes = Buffer.from(await zipRes.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(bytes.includes(Buffer.from('CANARY'))).toBe(false);
});
