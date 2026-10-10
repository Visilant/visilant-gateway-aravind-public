import 'reflect-metadata';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { GatewayConfig } from '../src/config';
import { DiagnosticRecorder, diagnosticContext } from '../src/infrastructure/diagnostics';
import { CaptureRepository, SettingRepository } from '../src/infrastructure/database/repositories';
import type { Logger } from '../src/infrastructure/logger';
import { DiagnosticsService, InvalidDiagnosticIdError, RecordingLockedError, RecordingStartError, RunNotFoundError, SegmentNotFoundError, RECORDING_SETTING } from '../src/application/services/DiagnosticsService';

let root: string, recorder: DiagnosticRecorder, service: DiagnosticsService;
let settings: Map<string, string>, set: jest.Mock, get: jest.Mock, captures: jest.Mock;
const env = process.env.GATEWAY_DIAGNOSTICS_DIR;
beforeEach(async () => {
    delete process.env.GATEWAY_DIAGNOSTICS_DIR;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-diagnostics-service-'));
    recorder = new DiagnosticRecorder(); settings = new Map();
    set = jest.fn(async (key, value) => { settings.set(key, value); });
    get = jest.fn(async key => settings.get(key) ?? null);
    captures = jest.fn().mockResolvedValue([]);
    service = new DiagnosticsService(Object.assign(new GatewayConfig(), { storage_root: root }), { info: jest.fn(), error: jest.fn() } as unknown as Logger,
        { set, get } as unknown as SettingRepository, { findByDiagnosticRunId: captures } as unknown as CaptureRepository, recorder);
});
afterEach(async () => {
    await recorder.stop(); await fs.rm(root, { recursive: true, force: true });
    if (env === undefined) delete process.env.GATEWAY_DIAGNOSTICS_DIR; else process.env.GATEWAY_DIAGNOSTICS_DIR = env;
});

test('lists old and current manifests newest first with an effective root', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
        const dir = path.join(root, 'diagnostics', ids[i]); await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ status: i === 0 ? 'stopped' : 'interrupted', updated_at: `2026-01-0${i + 1}`, ...(i === 0 ? {} : { started_at: `2026-01-0${i + 1}` }) }));
    }
    const result = await service.overview();
    expect(result.recording).toEqual({ enabled: false, locked_by: null, directory: path.join(root, 'diagnostics') });
    expect(result.segments.map(s => s.id)).toEqual([...ids].reverse());
    expect(result.segments[2].started_at).toBeNull();
});
test('environment locks the toggle and root without writing settings', async () => {
    process.env.GATEWAY_DIAGNOSTICS_DIR = root;
    await expect(service.setRecording(true)).rejects.toBeInstanceOf(RecordingLockedError);
    expect(service.status()).toMatchObject({ locked_by: 'env', directory: root }); expect(set).not.toHaveBeenCalled();
});
test('persists before starting and restarts in a distinct segment', async () => {
    set.mockImplementation(async (key, value) => { expect(recorder.enabled).toBe(value === 'off'); settings.set(key, value); });
    await service.setRecording(true); const first = recorder.segmentId!;
    expect(settings.get(RECORDING_SETTING)).toBe('on');
    await service.setRecording(false);
    expect(JSON.parse(await fs.readFile(path.join(root, 'diagnostics', first, 'manifest.json'), 'utf8')).status).toBe('stopped');
    await service.setRecording(true); expect(recorder.segmentId).not.toBe(first);
});
test('restores only an on setting, and skips settings for an environment override', async () => {
    await service.restoreAtBoot(); expect(recorder.enabled).toBe(false);
    settings.set(RECORDING_SETTING, 'off'); await service.restoreAtBoot(); expect(recorder.enabled).toBe(false);
    settings.set(RECORDING_SETTING, 'on'); await service.restoreAtBoot(); expect(recorder.enabled).toBe(true);
    get.mockClear(); process.env.GATEWAY_DIAGNOSTICS_DIR = root; await service.restoreAtBoot(); expect(get).not.toHaveBeenCalled();
});
test('reports a failed start while preserving the durable request', async () => {
    await fs.writeFile(path.join(root, 'diagnostics'), 'file');
    await expect(service.setRecording(true)).rejects.toBeInstanceOf(RecordingStartError);
    expect(service.status().enabled).toBe(false); expect(settings.get(RECORDING_SETTING)).toBe('on');
});
test('validates ids and distinguishes missing segments and capture-only runs', async () => {
    await expect(service.segment('../../etc')).rejects.toBeInstanceOf(InvalidDiagnosticIdError);
    await expect(service.run('x')).rejects.toBeInstanceOf(InvalidDiagnosticIdError);
    await expect(service.archive('../x')).rejects.toBeInstanceOf(InvalidDiagnosticIdError);
    await expect(service.segment(randomUUID())).rejects.toBeInstanceOf(SegmentNotFoundError);
    await expect(service.run(randomUUID())).rejects.toBeInstanceOf(RunNotFoundError);
    captures.mockResolvedValue([{ id: randomUUID(), status: 'SENT', sent_at: null }]);
    expect((await service.run(randomUUID())).captures).toHaveLength(1);
});
test('flushes buffered active events and rolls up runs across segments', async () => {
    await service.setRecording(true); const first = recorder.segmentId!;
    const run_id = randomUUID(), operation_id = randomUUID();
    diagnosticContext.run({ run_id, operation_id }, () => recorder.event('capture.queued'));
    const result = await service.segment(first);
    expect(result.segment.active).toBe(true); expect(result.runs[0]).toMatchObject({ run_id, acknowledged: 0, pending: 1 });
    await service.setRecording(false); await service.setRecording(true);
    diagnosticContext.run({ run_id, operation_id }, () => recorder.event('capture.delivered'));
    const active = await service.segment(recorder.segmentId!);
    expect(active.events).toContainEqual({ name: 'capture.delivered', count: 1 });
    expect(active.runs[0]).toMatchObject({ acknowledged: 0, pending: 0 });
    expect(await service.run(run_id)).toMatchObject({ acknowledged: 1, pending: 0, segments: expect.arrayContaining([first, recorder.segmentId]) });
});
test('archives a segment as a ZIP', async () => {
    await service.setRecording(true);
    const { stream } = await service.archive(recorder.segmentId!);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => { stream.on('data', chunk => chunks.push(chunk)); stream.on('end', resolve); stream.on('error', reject); });
    expect(Buffer.concat(chunks).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
});
test('serializes opposing recording requests', async () => {
    await Promise.all([service.setRecording(true), service.setRecording(false)]);
    expect(settings.get(RECORDING_SETTING)).toBe('off'); expect(recorder.enabled).toBe(false);
});

test('failed persisted recording logs the problem but does not prevent boot', async () => {
    await fs.writeFile(path.join(root, 'diagnostics'), 'file'); settings.set(RECORDING_SETTING, 'on');
    await expect(service.restoreAtBoot()).resolves.toBeUndefined(); expect(recorder.enabled).toBe(false);
});

test('a run roll-up can combine more events than the JavaScript argument limit', async () => {
    const { DiagnosticsStore } = require('../src/infrastructure/diagnostics/store');
    const run_id = randomUUID();
    const list = jest.spyOn(DiagnosticsStore.prototype, 'list').mockResolvedValue([{ segment_id: randomUUID() }] as never);
    const read = jest.spyOn(DiagnosticsStore.prototype, 'readEvents').mockResolvedValue({ events: Array.from({ length: 150000 }, () => ({ name: 'capture.queued', run_id })), malformed: 0 });
    try { expect((await service.run(run_id)).events).toEqual([{ name: 'capture.queued', count: 150000 }]); }
    finally { list.mockRestore(); read.mockRestore(); }
});
