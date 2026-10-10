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
    service = new CaptureService(config, logger as never, repository, builder as never, storage, worker as never, { validateCapture: jest.fn().mockResolvedValue(undefined), touch: jest.fn().mockResolvedValue(undefined) } as never);
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
    service = new CaptureService(config, logger as never, repository, builder as never, storage, worker as never, screenings as never);
    const created = await service.create(input, await upload('busy'), null, 'client-busy');
    expect(await repository.findById(created.id)).not.toBeNull();
    expect(worker.tick).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not record activity'));
});
