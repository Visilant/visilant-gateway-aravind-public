import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DataSource } from 'typeorm';
import type { GatewayConfig } from '../src/config';
import { CaptureService } from '../src/application/services/CaptureService';
import { CreateCaptureDto } from '../src/application/dto';
import { CaptureStatus } from '../src/infrastructure/database/entities';
import { CaptureRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { deriveUid } from '../src/infrastructure/dicom';
import { LocalDiskStorage } from '../src/infrastructure/storage';

let database: DataSource;
let repository: CaptureRepository;
let root: string;
let service: CaptureService;
let storage: LocalDiskStorage;
const config = { study_uid_root: '1.2.826.0.1.3680043.10.543', send_immediately: true } as GatewayConfig;
const input = {
    laterality: 'R', light: 'WHITE',
    worklist_entry: { accession_number: 'ACC1', study_instance_uid: '1.2.3', patient_id: 'p', patient_name: 'P' },
} as CreateCaptureDto;
const builder = { build: jest.fn() };
const worker = { tick: jest.fn().mockResolvedValue({ sent: 0, failed: 0 }) };
const telemetry = { record: jest.fn().mockResolvedValue(null) };
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

async function upload(name: string): Promise<string> {
    const target = path.join(root, `${name}.jpg`);
    await fs.writeFile(target, 'JPEG');
    return target;
}
async function objects(): Promise<string[]> {
    return (await fs.readdir(path.join(root, 'ACC1'))).filter((name) => name.endsWith('.dcm'));
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-capture-test-'));
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize();
    await database.runMigrations();
    repository = new CaptureRepository(database);
    storage = new LocalDiskStorage({ ...config, storage_root: root });
    builder.build.mockImplementation(async (_upload, _tags, target) => { await fs.writeFile(target, 'DICOM'); });
    service = new CaptureService(config, logger as never, repository, builder as never, storage, worker as never, { validateCapture: jest.fn().mockResolvedValue(undefined), touch: jest.fn().mockResolvedValue(undefined) } as never, telemetry as never);
});
afterEach(async () => {
    await database.destroy();
    await fs.rm(root, { recursive: true, force: true });
});

it('returns the first row on repeat without building, enqueueing or retaining another file', async () => {
    const first = await service.create(input, await upload('first'), null, 'client-1');
    const secondUpload = await upload('second');
    expect(await service.create(input, secondUpload, null, 'client-1')).toEqual(first);
    expect(await repository.findRecent()).toHaveLength(1);
    expect(await objects()).toHaveLength(1);
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(worker.tick).toHaveBeenCalledTimes(1);
    await expect(fs.access(secondUpload)).rejects.toThrow();
    expect(first.sop_instance_uid).toBe(deriveUid('instance:client-1', config.study_uid_root));
});

it('recovers concurrent same-key inserts, keeping the winning row and only its object', async () => {
    // Both builds must reach the barrier before either inserts: exercises the race,
    // rather than letting the second request take the early lookup shortcut.
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    builder.build.mockImplementation(async (_upload, _tags, target) => {
        await fs.writeFile(target, 'DICOM');
        if (++arrived === 2) release();
        await barrier;
    });
    const uploads = await Promise.all([upload('first'), upload('second')]);
    const result = await Promise.all(uploads.map((file) => service.create(input, file, null, 'same-key')));
    expect(result[0]).toEqual(result[1]);
    const rows = await repository.findRecent();
    expect(rows).toHaveLength(1);
    expect(await objects()).toEqual([`${rows[0].id}.dcm`]);
    expect(worker.tick).toHaveBeenCalledTimes(1);
    for (const file of uploads) await expect(fs.access(file)).rejects.toThrow();
});

it('returns current status on a repeat after delivery without requeueing', async () => {
    const first = await service.create(input, await upload('first'), null, 'sent-key');
    await repository.markSent(first.id, new Date().toISOString());
    await storage.remove(`ACC1/${first.id}.dcm`);
    const repeated = await service.create(input, await upload('second'), null, 'sent-key');
    expect(repeated.status).toBe(CaptureStatus.SENT);
    expect(await objects()).toEqual([]);
    expect(worker.tick).toHaveBeenCalledTimes(1);
});

it('keeps distinct captures and the existing UID derivation when no key is sent', async () => {
    const first = await service.create(input, await upload('first'), null);
    const second = await service.create(input, await upload('second'), null);
    expect(second.id).not.toBe(first.id);
    expect(first.sop_instance_uid).toBe(deriveUid(`instance:${first.id}`, config.study_uid_root));
    expect(second.sop_instance_uid).toBe(deriveUid(`instance:${second.id}`, config.study_uid_root));
    expect(await repository.findRecent()).toHaveLength(2);
    expect(await objects()).toHaveLength(2);
});

it('cleans a partial conversion and its temporary upload on a build failure', async () => {
    builder.build.mockImplementation(async (_upload, _tags, target) => {
        await fs.writeFile(target, 'partial');
        throw new Error('conversion failed');
    });
    const file = await upload('first');
    await expect(service.create(input, file, null, 'bad')).rejects.toThrow('conversion failed');
    expect(await objects()).toEqual([]);
    expect(await repository.findRecent()).toHaveLength(0);
    await expect(fs.access(file)).rejects.toThrow();
});

it('cleans an object but propagates an unrelated insert failure', async () => {
    jest.spyOn(repository, 'create').mockRejectedValue(new Error('disk full'));
    await expect(service.create(input, await upload('first'), null, 'bad')).rejects.toThrow('disk full');
    expect(await objects()).toEqual([]);
    expect(worker.tick).not.toHaveBeenCalled();
});

it('lists by study and status, computes file presence, and omits server file keys', async () => {
    const first = await service.create(input, await upload('first'), null);
    const second = await service.create(input, await upload('second'), null);
    const other = await service.create({ ...input, worklist_entry: { ...input.worklist_entry, study_instance_uid: '1.2.4' } }, await upload('other'), null);
    await repository.markSent(first.id, new Date().toISOString());
    await storage.remove(`ACC1/${first.id}.dcm`);
    expect((await service.list({ status: CaptureStatus.SENT })).map(row => row.id)).toEqual([first.id]);
    expect((await service.list({ study_instance_uid: '1.2.3' })).map(row => row.id).sort()).toEqual([first.id, second.id].sort());
    expect((await service.list({ study_instance_uid: '1.2.3', status: CaptureStatus.PENDING })).map(row => row.id)).toEqual([second.id]);
    expect(await service.get(first.id)).toMatchObject({ file_present: false });
    expect(await service.get(other.id)).toMatchObject({ file_present: true });
    for (const row of await service.list({})) expect(row).not.toHaveProperty('dicom_path');
    expect(await service.get('unknown')).toBeNull();
});

it('a failed screening activity update does not fail a capture that is already stored', async () => {
    const screenings = { validateCapture: jest.fn().mockResolvedValue(undefined), touch: jest.fn().mockRejectedValue(Error('SQLITE_BUSY')) };
    service = new CaptureService(config, logger as never, repository, builder as never, storage, worker as never, screenings as never, telemetry as never);
    const created = await service.create(input, await upload('busy'), null, 'client-busy');
    expect(await repository.findById(created.id)).not.toBeNull();
    expect(worker.tick).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not record activity'));
});

describe('ai.assessed telemetry', () => {
    const assessment = { schemaVersion: 1 as const, status: 'unavailable' as const, reason: 'eye_not_detected' as const, modelRevision: 'models-v1', modelManifestSha256: 'a'.repeat(64), assessedAt: '2026-10-08T12:00:00.000Z' };

    it('writes ai.assessed with the capture and screening ids and the assessment, once per capture', async () => {
        await database.query(`INSERT INTO screening (id, source_scope, order_key, accession_number, study_instance_uid, capture_ids, created_at, last_activity_at)
            VALUES ('screening-1', 'scope', 'order', 'ACC1', '1.2.3', '["client-ai"]', '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z')`);
        const withAi = { ...input, screening_id: 'screening-1', ai_assessment: assessment } as CreateCaptureDto;
        const created = await service.create(withAi, await upload('ai'), null, 'client-ai');
        expect(telemetry.record).toHaveBeenCalledTimes(1);
        expect(telemetry.record).toHaveBeenCalledWith('ai.assessed',
            { gateway_capture_id: created.id, laterality: 'R', light: 'WHITE', assessment },
            { capture_id: 'client-ai', screening_id: 'screening-1' },
            { event_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), occurred_at: expect.any(String) });
        // Never the worklist entry: that is where the patient is.
        expect(JSON.stringify(telemetry.record.mock.calls)).not.toMatch(/ACC1|patient/);
        // A retry of the same capture writes it again under the same event_id, which the
        // outbox ignores; that is how a write lost to a power cut is recovered.
        await service.create(withAi, await upload('ai-again'), null, 'client-ai');
        expect(telemetry.record).toHaveBeenCalledTimes(2);
        expect(telemetry.record.mock.calls[1]).toEqual(telemetry.record.mock.calls[0]);
    });

    it('uses the gateway capture id when the phone sent no idempotency key', async () => {
        const created = await service.create({ ...input, ai_assessment: assessment } as CreateCaptureDto, await upload('no-key'), null);
        expect(telemetry.record.mock.calls[0][2]).toEqual({ capture_id: created.id, screening_id: null });
    });

    it('writes nothing for a capture without an assessment', async () => {
        await service.create(input, await upload('plain'), null, 'client-plain');
        expect(telemetry.record).not.toHaveBeenCalled();
    });

    it('a retry after a lost telemetry write records it', async () => {
        telemetry.record.mockRejectedValueOnce(new Error('synthetic power cut'));
        const withAi = { ...input, ai_assessment: assessment } as CreateCaptureDto;
        await service.create(withAi, await upload('cut'), null, 'client-cut');
        await service.create(withAi, await upload('cut-retry'), null, 'client-cut');
        expect(telemetry.record).toHaveBeenCalledTimes(2);
        expect(telemetry.record.mock.calls[1][3]).toEqual(telemetry.record.mock.calls[0][3]);
    });

    it('a replay without an assessment writes nothing', async () => {
        await service.create(input, await upload('plain-1'), null, 'client-plain-2');
        await service.create(input, await upload('plain-2'), null, 'client-plain-2');
        expect(telemetry.record).not.toHaveBeenCalled();
    });

    it('a telemetry failure never fails the capture', async () => {
        telemetry.record.mockRejectedValueOnce(new Error('synthetic database error'));
        const created = await service.create({ ...input, ai_assessment: assessment } as CreateCaptureDto, await upload('fails'), null, 'client-fails');
        expect(created.status).toBe(CaptureStatus.PENDING);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/ai\.assessed/));
    });
});
