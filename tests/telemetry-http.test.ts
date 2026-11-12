import { mkdtempSync, rmSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Server } from 'http';
import { DataSource } from 'typeorm';
import Container from 'typedi';
import { GatewayServer } from '../src/presentation/server';
import { CONFIG, DATABASE, LOGGER } from '../src/tokens';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { AuthService } from '../src/application/services/AuthService';
import { SettingEntity, TelemetryEventEntity, UserRole } from '../src/infrastructure/database/entities';
import { GatewayConfig, TelemetryConfig } from '../src/config';
import { DicomBuilder } from '../src/infrastructure/dicom';
import { v7 as uuidv7 } from 'uuid';
import { DEVICE_ID, PAYLOADS, SESSION_ID, phoneEvent } from './fixtures/telemetry';

let server: Server, database: DataSource, directory: string, base: string, config: GatewayConfig;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

async function post(body: unknown, token: string | null = 'OPERATOR', raw?: string) {
    const response = await fetch(base + '/telemetry/events', {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        body: raw ?? JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) as any : undefined };
}
const rows = () => database.getRepository(TelemetryEventEntity).find({ order: { event_id: 'ASC' } });

beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'telemetry-http-')); Container.reset();
    database = new DataSource(buildDataSourceOptions(':memory:')); await database.initialize(); await database.runMigrations();
    config = Object.assign(new GatewayConfig(), {
        centre_code: 'SYNTHETIC', listen_port: 0, storage_root: directory, study_uid_root: '1.2.3', send_immediately: false,
        mwl: { host: 'synthetic', port: 104, called_ae: 'W', calling_ae: 'V' },
        telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC-SYNTH-01' }),
    });
    Container.set(CONFIG, config); Container.set(DATABASE, database); Container.set(LOGGER, logger);
    Container.set(AuthService, { authenticate: async (header: string) => header === 'Bearer OPERATOR' ? { id: null, role: UserRole.OPERATOR } : header === 'Bearer ADMIN' ? { id: null, role: UserRole.ADMIN } : null } as never);
    Container.set(DicomBuilder, { build: async (_input: string, _tags: unknown, target: string) => { await fs.writeFile(target, 'SYNTHETIC DICOM'); } } as never);
    server = await Container.get(GatewayServer).start(); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await database.destroy(); Container.reset(); rmSync(directory, { recursive: true, force: true }); });

describe('before sign-in', () => {
    const PRE_SIGN_IN = ['app.started', 'app.crashed', 'operation.failed', 'device.health', 'gateway.unreachable'];
    const SIGNED_IN_ONLY = ['capture.taken', 'capture.uploaded', 'capture.upload_failed', 'yolo.autocapture'];

    test('accepts the pre-sign-in types without a token and marks the rows unauthenticated', async () => {
        const events = PRE_SIGN_IN.map(type => phoneEvent(type));
        const response = await post({ events }, null);
        expect(response.status).toBe(200);
        expect(response.json.data.accepted).toEqual(events.map(e => e.event_id));
        expect((await rows()).map(r => r.authenticated)).toEqual(PRE_SIGN_IN.map(() => false));
    });

    test('a signed-in phone marks its rows authenticated', async () => {
        await post({ events: [phoneEvent('device.health')] });
        expect((await rows())[0].authenticated).toBe(true);
    });

    test('an invalid or expired token is treated as no token', async () => {
        expect((await post({ events: [phoneEvent('device.health')] }, 'EXPIRED')).status).toBe(200);
        expect((await rows())[0].authenticated).toBe(false);
        expect((await post({ events: [phoneEvent('capture.taken')] }, 'EXPIRED')).status).toBe(401);
    });

    test.each(SIGNED_IN_ONLY)('%s still needs a signed-in phone, and the whole batch is refused', async (type) => {
        const response = await post({ events: [phoneEvent('device.health'), phoneEvent(type)] }, null);
        expect(response.status).toBe(401);
        expect(response.json.error).toMatch(new RegExp(`${type.replace('.', '\\.')}.*sign`));
        expect(await rows()).toEqual([]);
    });

    test('a signed-in phone may still send every type', async () => {
        const response = await post({ events: Object.keys(PAYLOADS).map(type => phoneEvent(type)) });
        expect(response.status).toBe(200);
    });

    test('without a token: 30 requests a minute per client, then 429 with Retry-After', async () => {
        let now = Date.parse('2026-11-12T00:00:00.000Z');
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            for (let i = 0; i < 30; i++) expect((await post({ events: [phoneEvent('device.health')] }, null)).status).toBe(200);
            const limited = await fetch(base + '/telemetry/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [phoneEvent('device.health')] }) });
            expect(limited.status).toBe(429);
            expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
            expect((await limited.json() as any).error).toMatch(/sign in|minute/);
            // Invalid requests count too, so the limit cannot be dodged with bad bodies.
            expect((await post({ events: [] }, null)).status).toBe(429);
            // A signed-in phone is not limited by its neighbours.
            expect((await post({ events: [phoneEvent('device.health')] })).status).toBe(200);
            now += 60_000;
            expect((await post({ events: [phoneEvent('device.health')] }, null)).status).toBe(200);
            expect(await rows()).toHaveLength(32);
        } finally { jest.restoreAllMocks(); }
    });

    test('telemetry off: 204 without a token as well, and nothing counts against the limit', async () => {
        config.telemetry.enabled = false;
        for (let i = 0; i < 35; i++) expect((await post({ events: [phoneEvent('device.health')] }, null)).status).toBe(204);
    });
});

test('accepts one valid event of every phone type and stores the envelope with site, gateway and receipt time', async () => {
    const events = Object.keys(PAYLOADS).map(type => phoneEvent(type));
    const before = new Date().toISOString();
    const response = await post({ events });
    expect(response.status).toBe(200);
    expect(response.json.data).toEqual({ accepted: events.map(e => e.event_id), duplicate: [], dropped: [] });
    const stored = await rows();
    expect(stored).toHaveLength(events.length);
    const gatewayId = (await database.getRepository(SettingEntity).findOneByOrFail({ key: 'telemetry.gateway_id' })).value;
    expect(gatewayId).toMatch(/^[0-9a-f-]{36}$/);
    for (const event of events) {
        const row = stored.find(r => r.event_id === event.event_id)!;
        expect(row).toMatchObject({ type: event.type, schema_version: 1, occurred_at: event.occurred_at, site_id: 'VC-SYNTH-01', gateway_id: gatewayId, device_id: DEVICE_ID, session_id: SESSION_ID, capture_id: event.capture_id ?? null, screening_id: event.screening_id ?? null, sent_at: null, authenticated: true });
        expect(row.received_at >= before).toBe(true);
        expect(JSON.parse(row.payload)).toEqual(event.payload);
    }
});

test('a retried event is reported as a duplicate and stored once, and the gateway_id stays the same', async () => {
    const first = phoneEvent('device.health');
    expect((await post({ events: [first] })).json.data.accepted).toEqual([first.event_id]);
    const second = phoneEvent('app.started');
    const response = await post({ events: [first, second, first] });
    expect(response.json.data).toEqual({ accepted: [second.event_id], duplicate: [first.event_id, first.event_id], dropped: [] });
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map(r => r.gateway_id)).size).toBe(1);
});

test('telemetry off: 204, nothing stored, not even a gateway_id', async () => {
    config.telemetry.enabled = false;
    const response = await post({ events: [phoneEvent('device.health')] });
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(await rows()).toEqual([]);
    expect(await database.getRepository(SettingEntity).findOneBy({ key: 'telemetry.gateway_id' })).toBeNull();
});

test('more than 100 events or more than 256 KB is 413', async () => {
    const hundred = Array.from({ length: 100 }, () => phoneEvent('device.health'));
    expect((await post({ events: hundred })).status).toBe(200);
    expect((await post({ events: [...hundred.map(e => ({ ...e })), phoneEvent('device.health')] })).status).toBe(413);
    const big = await post(undefined, 'OPERATOR', JSON.stringify({ events: [phoneEvent('device.health')], pad: 'x'.repeat(256 * 1024) }));
    expect(big.status).toBe(413);
    expect(big.json).toEqual({ error: expect.stringMatching(/256 KB/) });
    expect(await rows()).toHaveLength(100);
});

test('malformed JSON is 400 and the body never comes back or reaches the log', async () => {
    const response = await post(undefined, 'OPERATOR', '{"events": [ "SYNTHETIC-PATIENT-NAME" ');
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('SYNTHETIC-PATIENT-NAME');
    expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])).not.toContain('SYNTHETIC-PATIENT-NAME');
});

describe('rejections', () => {
    const cases: Array<[string, Record<string, unknown> | unknown]> = [
        ['an unknown type', phoneEvent('device.health', { type: 'device.unknown' })],
        ['a gateway-only type sent by a phone', phoneEvent('device.health', { type: 'gateway.heartbeat' })],
        ['ai.assessed sent by a phone', phoneEvent('device.health', { type: 'ai.assessed' })],
        ['an unknown envelope key', phoneEvent('device.health', { patient_name: 'x' })],
        ['authenticated set by the phone', phoneEvent('device.health', { authenticated: true })],
        ['an unknown payload key', phoneEvent('device.health', { payload: { ...PAYLOADS['device.health'].payload, note: 'x' } })],
        ['an event_id that is not a lowercase UUIDv7', phoneEvent('device.health', { event_id: '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' })],
        ['an upper-case event_id', phoneEvent('device.health', { event_id: (phoneEvent('device.health').event_id as string).toUpperCase() })],
        ['schema_version 2', phoneEvent('device.health', { schema_version: 2 })],
        ['occurred_at that is not UTC ISO 8601', phoneEvent('device.health', { occurred_at: '2026-11-12 10:00' })],
        ['occurred_at that is not a real date', phoneEvent('device.health', { occurred_at: '2026-13-45T10:00:00.000Z' })],
        ['a missing device_id', phoneEvent('device.health', { device_id: undefined })],
        ['a missing session_id', phoneEvent('device.health', { session_id: undefined })],
        ['a capture event without capture_id', phoneEvent('capture.taken', { capture_id: undefined })],
        ['a payload that is not an object', phoneEvent('device.health', { payload: 'x' })],
        ['a missing payload', phoneEvent('device.health', { payload: undefined })],
        ['a battery percentage over 100', phoneEvent('device.health', { payload: { ...PAYLOADS['device.health'].payload, battery_pct: 101 } })],
        ['a crash with an exception message', phoneEvent('app.crashed', { payload: { ...PAYLOADS['app.crashed'].payload, message: 'x' } })],
        ['a crash frame from a non-source file', phoneEvent('app.crashed', { payload: { ...PAYLOADS['app.crashed'].payload, stack_frames: [{ class: 'a.B', method: 'c', file: 'libc.so', line: 1 }] } })],
        ['a yolo rejection reason not in the list', phoneEvent('yolo.autocapture', { payload: { ...PAYLOADS['yolo.autocapture'].payload, rejected_frames: { blurry: 1 } } })],
        ['an outage note counting an unknown type', phoneEvent('gateway.unreachable', { payload: { ...PAYLOADS['gateway.unreachable'].payload, dropped: { 'x.y': 1 } } })],
    ];
    test.each(cases)('rejects %s with 400 and stores nothing from the batch', async (_name, bad) => {
        const good = phoneEvent('app.started');
        const response = await post({ events: [good, bad] });
        expect(response.status).toBe(400);
        expect(response.json.details).toBeDefined();
        expect(await rows()).toEqual([]);
    });

    test.each([[{}], [{ events: [] }], [{ events: 'x' }], [{ events: [phoneEvent('app.started')], extra: 1 }]])('rejects a malformed batch %j', async (body) => {
        expect((await post(body)).status).toBe(400);
    });

    // A free-text field is where a patient name would land. It must never come back in
    // the response or reach the log; the log gets the type and the field name only.
    test('never echoes a rejected value, and logs only the type and the field', async () => {
        const name = 'SYNTHETIC PATIENT NAME';
        const bad = phoneEvent('operation.failed', { payload: { operation: name, error_code: 'E1' } });
        const response = await post({ events: [bad] });
        expect(response.status).toBe(400);
        expect(response.text).not.toContain(name);
        expect(response.text).toContain('operation');
        const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.error.mock.calls]);
        expect(logged).not.toContain(name);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/operation\.failed.*payload\.operation/));
    });

    // A key name is client text like any value: it can hold a name or a forged log line.
    test('never echoes or logs a client-sent key name; returns only the event index, our field path and a reason', async () => {
        const key = 'SYNTHETIC PATIENT NAME\n2026-11-12 ERROR forged line';
        const bad = phoneEvent('device.health', { payload: { ...PAYLOADS['device.health'].payload, [key]: 1 } });
        const response = await post({ events: [phoneEvent('app.started'), bad] }, null);
        expect(response.status).toBe(400);
        expect(response.text).not.toContain('SYNTHETIC PATIENT NAME');
        expect(response.text).not.toContain('forged');
        expect(response.json).toEqual({ error: 'telemetry request failed validation', details: [{ event: 1, field: 'payload.<unknown key>', reason: 'unknown_key' }] });
        const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.error.mock.calls]);
        expect(logged).not.toContain('SYNTHETIC PATIENT NAME');
        expect(logged).not.toContain('forged');
        expect(logger.warn).toHaveBeenCalledWith('telemetry rejected: event 1 (device.health) payload.<unknown key> unknown_key');
    });

    test('a bad value in a known field names the field and a fixed reason only', async () => {
        const bad = phoneEvent('device.health', { payload: { ...PAYLOADS['device.health'].payload, battery_pct: 101 } });
        const response = await post({ events: [bad] });
        expect(response.json.details).toEqual([{ event: 0, field: 'payload.battery_pct', reason: 'invalid' }]);
        const missing = phoneEvent('device.health', { payload: undefined });
        expect((await post({ events: [missing] })).json.details).toEqual([{ event: 0, field: 'payload', reason: 'missing' }]);
    });

    test('an unknown key on the batch itself is reported without its name', async () => {
        const response = await post({ events: [phoneEvent('app.started')], 'SYNTHETIC-KEY': 1 });
        expect(response.json.details).toEqual([{ event: null, field: '<unknown key>', reason: 'unknown_key' }]);
        expect(response.text).not.toContain('SYNTHETIC-KEY');
    });

    test('does not log a type it does not know, because a type is free text until it is checked', async () => {
        await post({ events: [phoneEvent('device.health', { type: 'SYNTHETIC-PATIENT' })] });
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SYNTHETIC-PATIENT');
    });
});

test('POST /captures with an AI assessment writes ai.assessed, without the worklist entry', async () => {
    const assessment = { schemaVersion: 1, status: 'unavailable', reason: 'eye_not_detected', modelRevision: 'models-v1', modelManifestSha256: 'a'.repeat(64), assessedAt: '2026-10-08T12:00:00.000Z' };
    const form = new FormData();
    form.append('file', new Blob(['synthetic JPEG'], { type: 'image/jpeg' }), 'test.jpg');
    form.append('worklist_entry', JSON.stringify({ accession_number: 'SYNTH-ACC', study_instance_uid: '1.2.3.4', patient_id: 'SYNTH-MRN', patient_name: 'SYNTHETIC^PATIENT' }));
    form.append('laterality', 'L'); form.append('light', 'WHITE'); form.append('ai_assessment', JSON.stringify(assessment));
    const response = await fetch(base + '/captures', { method: 'POST', headers: { Authorization: 'Bearer OPERATOR', 'Idempotency-Key': 'phone-capture-1' }, body: form });
    expect(response.status).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({ type: 'ai.assessed', capture_id: 'phone-capture-1', device_id: null, site_id: 'VC-SYNTH-01', authenticated: null });
    expect(JSON.parse(row.payload)).toEqual({ gateway_capture_id: (await response.json() as any).data.id, laterality: 'L', light: 'WHITE', assessment });
    expect(JSON.stringify(row)).not.toMatch(/SYNTH-ACC|SYNTH-MRN|PATIENT/);
});

describe('GET /telemetry/export', () => {
    async function exportRows(query = '', token: string | null = 'ADMIN') {
        const response = await fetch(base + '/telemetry/export' + query, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const text = await response.text();
        return { status: response.status, headers: response.headers, text, lines: text ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : [] };
    }

    test('is for admins only', async () => {
        expect((await exportRows('', null)).status).toBe(401);
        expect((await exportRows('', 'OPERATOR')).status).toBe(403);
    });

    test('streams unsent rows as NDJSON in the push envelope, in the order they were written', async () => {
        const events = [phoneEvent('device.health'), phoneEvent('app.started'), phoneEvent('capture.taken')];
        await post({ events });
        const stored = await rows();
        await database.getRepository(TelemetryEventEntity).update({ event_id: events[1].event_id as string }, { sent_at: new Date().toISOString() });
        const response = await exportRows();
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
        expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="telemetry-VC-SYNTH-01-\d{8}T\d{6}Z\.ndjson"$/);
        const { sent_at: _s, seq: _q, push_attempts: _a, quarantined_at: _qa, quarantine_reason: _qr, ...first } = stored.find(r => r.event_id === events[0].event_id)!;
        expect(response.lines.map(l => l.event_id)).toEqual([events[0].event_id, events[2].event_id]);
        expect(response.lines[0]).toEqual({ ...first, payload: events[0].payload });
        expect(response.text.endsWith('\n')).toBe(true);
    });

    test('since returns only rows after that event_id', async () => {
        const events = [phoneEvent('device.health'), phoneEvent('device.health'), phoneEvent('device.health')];
        await post({ events });
        expect((await exportRows(`?since=${events[0].event_id}`)).lines.map(l => l.event_id)).toEqual([events[1].event_id, events[2].event_id]);
    });

    // A phone whose clock is behind makes event_ids that sort before ones already
    // stored. since means "written after", so those rows are not skipped.
    test('since follows the order rows were stored, not the event_id clock', async () => {
        const first = phoneEvent('device.health');
        await post({ events: [first] });
        const behind = phoneEvent('device.health', { event_id: uuidv7({ msecs: Date.now() - 86_400_000 }) });
        await post({ events: [behind] });
        expect((await exportRows(`?since=${first.event_id}`)).lines.map(l => l.event_id)).toEqual([behind.event_id]);
    });

    test('a since that is not in the outbox is 400, with what to do', async () => {
        const response = await exportRows(`?since=${uuidv7()}`);
        expect(response.status).toBe(400);
        expect(JSON.parse(response.text).error).toMatch(/omit since/);
    });

    test('an empty outbox is an empty file', async () => {
        const response = await exportRows();
        expect(response.status).toBe(200);
        expect(response.text).toBe('');
    });

    test('rejects a since that is not an event_id, and unknown query keys', async () => {
        expect((await exportRows('?since=SYNTHETIC-PATIENT')).status).toBe(400);
        expect((await exportRows('?since=SYNTHETIC-PATIENT')).text).not.toContain('SYNTHETIC-PATIENT');
        expect((await exportRows('?from=x')).status).toBe(400);
    });

    test('streams a backlog larger than one page', async () => {
        for (let i = 0; i < 12; i++) await post({ events: Array.from({ length: 100 }, () => phoneEvent('device.health')) });
        const response = await exportRows();
        expect(response.lines).toHaveLength(1200);
        const ids = response.lines.map(l => l.event_id);
        expect([...ids].sort()).toEqual(ids);
        expect(new Set(ids).size).toBe(1200);
    });
});
