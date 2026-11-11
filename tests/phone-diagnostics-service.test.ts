import 'reflect-metadata';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { GatewayConfig } from '../src/config';
import { DiagnosticRecorder } from '../src/infrastructure/diagnostics';
import { CaptureRepository, SettingRepository } from '../src/infrastructure/database/repositories';
import type { Logger } from '../src/infrastructure/logger';
import { DiagnosticsService, InvalidDiagnosticIdError, PhoneNotFoundError } from '../src/application/services/DiagnosticsService';
import type { PhoneBatchDto, PhoneCrashItemDto, PhoneEventItemDto } from '../src/application/dto/phone-diagnostics.dto';

let root: string, service: DiagnosticsService, recorder: DiagnosticRecorder;
const env = process.env.GATEWAY_DIAGNOSTICS_DIR;
beforeEach(async () => {
    delete process.env.GATEWAY_DIAGNOSTICS_DIR;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-phone-service-'));
    recorder = new DiagnosticRecorder();
    service = new DiagnosticsService(Object.assign(new GatewayConfig(), { storage_root: root }), { info: jest.fn(), error: jest.fn() } as unknown as Logger,
        { set: jest.fn(), get: jest.fn() } as unknown as SettingRepository, { findByDiagnosticRunId: jest.fn().mockResolvedValue([]) } as unknown as CaptureRepository, recorder);
});
afterEach(async () => {
    await recorder.stop(); await fs.rm(root, { recursive: true, force: true });
    if (env === undefined) delete process.env.GATEWAY_DIAGNOSTICS_DIR; else process.env.GATEWAY_DIAGNOSTICS_DIR = env;
});

let sequence = 0;
const event = (name: string, attributes: Record<string, unknown> = {}, extra: Partial<PhoneEventItemDto> = {}): PhoneEventItemDto => ({
    stream: 'events', name, sequence: ++sequence, utc_ms: 1_700_000_000_000 + sequence * 1000, monotonic_ms: sequence * 1000, outcome: 'ok', attributes, ...extra,
});
const crash = (extra: Partial<PhoneCrashItemDto> = {}): PhoneCrashItemDto => ({
    crash_id: randomUUID(), source: 'js', utc_ms: 1_700_000_000_000 + ++sequence * 1000, error_type: 'TypeError', message: 'undefined is not a function',
    stack: ['at CaptureScreen (file:///data/user/0/org.visilant/files/src/screens/CaptureScreen.js:10:2)'], route: 'Capture', ...extra,
});
const batch = (device_id: string, events: PhoneEventItemDto[] = [], crashes: PhoneCrashItemDto[] = [], extra: Partial<PhoneBatchDto> = {}): PhoneBatchDto => ({
    device_id, batch_id: randomUUID(), manufacturer: 'Synthetic', device_model: 'Pixel Test', android_version: '14', api_level: 34, app_version: '2.1.0',
    model_revision: 'eye-2026.10', status: { battery_level: 80, charging: false, thermal_status: 1, network_kind: 'wifi', wifi_connected: true, seeker_connected: true, seeker_generation: 2, pending_uploads: 1, failed_uploads: 0, free_storage_bytes: 5e9 },
    events, crashes, ...extra,
});
const phoneDir = (device: string) => path.join(root, 'diagnostics', 'phones', device);

test('ingest writes a phone manifest with counters and the latest status snapshot', async () => {
    const device = randomUUID();
    const first = batch(device, [
        event('seeker.disconnected', { seeker_reason: 'detached' }),
        event('network.change', { network_kind: 'none', wifi_connected: false }),
        event('network.change', { network_kind: 'wifi', wifi_connected: true }),
        event('capture.burst', { trigger: 'auto', shot_count: 5, quality_score: 100 }),
        event('capture.burst', { trigger: 'auto', shot_count: 5, quality_score: 50 }, { outcome: 'aborted' }),
        event('assessment.result', { assessment_status: 'ready' }),
        event('assessment.result', { assessment_status: 'unavailable', assessment_reason: 'eye_not_detected' }),
        { ...event('resource.sample', { battery_level: 80 }), stream: 'resources' },
    ], [crash(), crash({ app_version: '2.0.9' })]);
    expect(await service.ingest(first)).toEqual({ accepted_events: 8, accepted_crashes: 2, duplicate_batch: false });
    const [phone] = (await service.listPhones()).phones;
    expect(phone).toMatchObject({
        device_id: device, manufacturer: 'Synthetic', device_model: 'Pixel Test', app_version: '2.1.0', model_revision: 'eye-2026.10',
        status: { battery_level: 80, seeker_generation: 2 },
        counts: { events: 7, crashes: 2, seeker_disconnects: 1, wifi_disconnects: 1, captures_taken: 5, assessments_ready: 1, assessments_unavailable: 1 },
    });
    expect(typeof phone.first_seen_at).toBe('string');
    const detail = await service.phoneDetail(device);
    expect(detail.crashes.map(c => c.app_version)).toEqual(['2.0.9', null]);

    // A second batch accumulates counters and replaces the status snapshot.
    await service.ingest(batch(device, [event('capture.burst', { trigger: 'manual', shot_count: 3 })], [], { app_version: '2.1.1', status: { battery_level: 42, charging: true } }));
    const [updated] = (await service.listPhones()).phones;
    expect(updated.counts).toMatchObject({ events: 8, captures_taken: 8 });
    expect(updated.app_version).toBe('2.1.1');
    expect(updated.status).toEqual({ battery_level: 42, charging: true });
    expect(updated.first_seen_at).toBe(phone.first_seen_at);
});

test('a retried batch is acknowledged as a duplicate and not counted twice', async () => {
    const device = randomUUID(), body = batch(device, [event('capture.burst', { trigger: 'auto', shot_count: 2 })]);
    await service.ingest(body);
    expect(await service.ingest(body)).toEqual({ accepted_events: 0, accepted_crashes: 0, duplicate_batch: true });
    expect((await service.listPhones()).phones[0].counts).toMatchObject({ events: 1, captures_taken: 2 });
});

test('patient data never reaches disk: attributes are allowlisted and crash text is sanitized', async () => {
    const device = randomUUID();
    await service.ingest(batch(device, [event('capture.burst', { trigger: 'auto', patient_name: 'CANARY^PATIENT', patient_id: 'CANARY-MRN', accession_number: 'CANARY-ACC', stage: 'CANARY PATIENT' })],
        [crash({ message: 'save failed for patient CANARY-MRN', stack: ['at save (CANARY^PATIENT.js:1)', 'at ok (file:///data/user/0/x/y/z.js:1:2)'] })]));
    const dir = phoneDir(device);
    const text = (await Promise.all((await fs.readdir(dir)).map(name => fs.readFile(path.join(dir, name), 'utf8')))).join('\n');
    expect(text).not.toContain('CANARY');
    const detail = await service.phoneDetail(device);
    expect(detail.crashes[0]).toMatchObject({ message: 'save failed for [redacted]', stack: ['at ok (y/z.js:1:2)'] });
    expect(detail.recent_events[0].attributes).toEqual({ trigger: 'auto' });
});

test('listPhones returns the most recently seen phone first', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await service.ingest(batch(a));
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.ingest(batch(b));
    expect((await service.listPhones()).phones.map(p => p.device_id)).toEqual([b, a]);
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.ingest(batch(a));
    expect((await service.listPhones()).phones.map(p => p.device_id)).toEqual([a, b]);
});

test('phoneDetail rolls up detector, assessments, connectivity, crashes, events and resources', async () => {
    const device = randomUUID().toUpperCase();
    const events = [
        event('capture.burst', { trigger: 'auto', shot_count: 5, quality_score: 100 }, { duration_ms: 40 }),
        event('capture.burst', { trigger: 'auto', shot_count: 5, quality_score: 200 }, { duration_ms: 60 }),
        event('capture.burst', { trigger: 'manual', shot_count: 3, quality_score: 300 }, { duration_ms: 80 }),
        event('capture.selected', { operator_overrode_suggested: false }),
        event('capture.selected', { operator_overrode_suggested: false }),
        event('capture.selected', { operator_overrode_suggested: true }),
        event('assessment.result', { assessment_status: 'ready', eye_gate_passed: true, cornea_label: 'normal', cornea_confidence: 0.9, cornea_entropy: 0.1, lens_label: 'clear', lens_confidence: 0.8, lens_entropy: 0.3, pterygium_label: 'negative', pterygium_confidence: 0.95, pterygium_entropy: 0.05 }, { duration_ms: 120 }),
        event('assessment.result', { assessment_status: 'ready', eye_gate_passed: true, cornea_label: 'scar', cornea_confidence: 0.6, cornea_entropy: 0.7, lens_label: 'clear', lens_confidence: 0.7, lens_entropy: 0.4 }, { duration_ms: 140 }),
        event('assessment.result', { assessment_status: 'unavailable', eye_gate_passed: false, assessment_reason: 'eye_not_detected' }),
        event('assessment.result', { assessment_status: 'unavailable', assessment_reason: 'assessment_timeout' }),
        event('assessment.result', { assessment_status: 'unavailable', assessment_reason: 'assessment_failed' }),
        event('seeker.disconnected', { seeker_reason: 'heartbeat_timeout', seeker_generation: 3 }),
        event('seeker.failsafe', { lights_lost: true }),
        event('seeker.opened', { seeker_generation: 4 }),
        event('network.change', { network_kind: 'none', wifi_connected: false }),
        event('network.restored', { offline_duration_ms: 9000 }),
        event('http.request', { status: 200 }),
        { ...event('resource.sample', { battery_level: 50, battery_temperature_c: 39, thermal_status: 2, cpu_percent: 30, pss_bytes: 1000, available_memory_bytes: 2000, firmware_version: '1.0' }), stream: 'resources' as const },
    ];
    const older = crash({ utc_ms: 1 }), newer = crash({ utc_ms: 2, source: 'native', error_type: 'java.lang.IllegalStateException' });
    await service.ingest(batch(device, events, [older, newer]));
    const detail = await service.phoneDetail(device);
    expect(detail.phone.device_id).toBe(device.toLowerCase());
    expect(detail.captures_and_models.detector).toEqual({ bursts_auto: 2, bursts_manual: 1, suggested_kept: 2, suggested_overridden: 1, quality_score_p50: 200, quality_score_p95: 300 });
    expect(detail.captures_and_models.assessments).toEqual({
        ready: 2, eye_not_detected: 1, failed_or_timeout: 2,
        by_task: { cornea: { normal: 1, scar: 1 }, lens: { clear: 2 }, pterygium: { negative: 1 } },
        confidence_p50: { cornea: 0.6, lens: 0.7, pterygium: 0.95 },
        entropy_p50: { cornea: 0.1, lens: 0.3, pterygium: 0.05 },
    });
    expect(detail.captures_and_models.spans.map(s => s.name)).toEqual(expect.arrayContaining(['phone.capture.burst.ok', 'phone.assessment.result.ok']));
    expect(detail.connectivity.map(e => e.name)).toEqual(['network.restored', 'network.change', 'seeker.opened', 'seeker.failsafe', 'seeker.disconnected']);
    expect(detail.connectivity[4].attributes).toEqual({ seeker_reason: 'heartbeat_timeout', seeker_generation: 3 });
    expect(detail.crashes.map(c => c.crash_id)).toEqual([newer.crash_id, older.crash_id]);
    expect(detail.recent_events[0].name).toBe('http.request');
    expect(detail.recent_events).toHaveLength(17);
    expect(detail.resources).toEqual([{ name: 'resource.sample', utc_ms: expect.any(Number), battery_level: 50, battery_temperature_c: 39, thermal_status: 2, cpu_percent: 30, pss_bytes: 1000, available_memory_bytes: 2000 }]);
});

test('phoneDetail caps its lists and reports null quantiles when there is no data', async () => {
    const device = randomUUID();
    await service.ingest(batch(device, Array.from({ length: 120 }, () => event('seeker.opened')), Array.from({ length: 20 }, () => crash())));
    for (let i = 0; i < 3; i++) await service.ingest(batch(device, [], Array.from({ length: 20 }, () => crash())));
    const detail = await service.phoneDetail(device);
    expect(detail.recent_events).toHaveLength(100);
    expect(detail.connectivity).toHaveLength(50);
    expect(detail.crashes).toHaveLength(50);
    expect(detail.captures_and_models.detector).toMatchObject({ quality_score_p50: null, quality_score_p95: null });
    expect(detail.captures_and_models.assessments.confidence_p50).toEqual({ cornea: null, lens: null, pterygium: null });
});

test('unknown and malformed device ids are distinguished', async () => {
    await expect(service.phoneDetail(randomUUID())).rejects.toBeInstanceOf(PhoneNotFoundError);
    await expect(service.phoneArchive(randomUUID())).rejects.toBeInstanceOf(PhoneNotFoundError);
    await expect(service.phoneDetail('../../etc')).rejects.toBeInstanceOf(InvalidDiagnosticIdError);
    await expect(service.phoneArchive('x')).rejects.toBeInstanceOf(InvalidDiagnosticIdError);
    expect(await service.listPhones()).toEqual({ phones: [] });
});

test('archives a phone as a ZIP', async () => {
    const device = randomUUID();
    await service.ingest(batch(device, [event('seeker.opened')], [crash()]));
    const { id, stream } = await service.phoneArchive(device);
    expect(id).toBe(device);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    const zip = Buffer.concat(chunks);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zip.includes(Buffer.from(`${device}/crashes.jsonl`))).toBe(true);
});

test('phone directories live beside recorder segments without being mistaken for one', async () => {
    const device = randomUUID();
    await service.ingest(batch(device));
    await service.setRecording(true);
    expect((await service.overview()).segments.map(s => s.id)).toEqual([recorder.segmentId]);
    expect((await service.listPhones()).phones).toHaveLength(1);
});
