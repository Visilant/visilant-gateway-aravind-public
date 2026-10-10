import { mkdtempSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DataSource } from 'typeorm';
import type { GatewayConfig } from '../src/config';
import { RetentionService } from '../src/application/services/RetentionService';
import { CaptureEntity, CaptureStatus } from '../src/infrastructure/database/entities';
import { CaptureRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { LocalDiskStorage } from '../src/infrastructure/storage';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let database: DataSource;
let repository: CaptureRepository;
let root: string;

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
    return { retention: 'KEEP', retention_keep_count: 10, storage_root: root, ...overrides } as GatewayConfig;
}

const sentAt = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString();

async function row(id: string, status: CaptureStatus, sent: string | null): Promise<string> {
    const key = `ACC/${id}.dcm`;
    await fs.mkdir(path.join(root, 'ACC'), { recursive: true });
    await fs.writeFile(path.join(root, key), 'dcm');
    await database.getRepository(CaptureEntity).save(Object.assign(new CaptureEntity(), {
        id, dicom_path: key, status, study_instance_uid: '1.2.3', series_instance_uid: '1.2.3.1',
        sop_instance_uid: `1.2.3.1.${id}`, accession_number: 'ACC', attempts: 1, next_attempt_at: null,
        last_error: null, created_by: null, created_at: '2026-01-01T00:00:00.000Z', sent_at: sent,
    }));
    return key;
}

const exists = (key: string) => fs.access(path.join(root, key)).then(() => true, () => false);

function service(cfg: GatewayConfig = config()): RetentionService {
    return new RetentionService(cfg, logger as never, repository, new LocalDiskStorage(cfg));
}

beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'gw-retention-'));
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize();
    await database.runMigrations();
    repository = new CaptureRepository(database);
});

afterEach(async () => {
    await database.destroy();
    await fs.rm(root, { recursive: true, force: true });
});

describe('RetentionService.prune', () => {
    it('keeps the files of the newest ten SENT captures and removes the rest', async () => {
        const keys: string[] = [];
        for (let i = 1; i <= 12; i++) keys.push(await row(`s${i}`, CaptureStatus.SENT, sentAt(i)));
        expect(await service().prune('incremental')).toEqual({ removed: 2 });
        expect(await exists(keys[0])).toBe(false);
        expect(await exists(keys[1])).toBe(false);
        for (const key of keys.slice(2)) expect(await exists(key)).toBe(true);
        const rows = await database.getRepository(CaptureEntity).count();
        expect(rows).toBe(12);
    });

    it('never touches PENDING or FAILED files, however old', async () => {
        const pending = await row('p', CaptureStatus.PENDING, null);
        const failed = await row('f', CaptureStatus.FAILED, null);
        for (let i = 1; i <= 11; i++) await row(`s${i}`, CaptureStatus.SENT, sentAt(i));
        await service().prune('full');
        expect(await exists(pending)).toBe(true);
        expect(await exists(failed)).toBe(true);
    });

    it('removes nothing when the window is larger than the number of SENT rows', async () => {
        const keys = [await row('s1', CaptureStatus.SENT, sentAt(1)), await row('s2', CaptureStatus.SENT, sentAt(2))];
        expect(await service().prune('full')).toEqual({ removed: 0 });
        for (const key of keys) expect(await exists(key)).toBe(true);
        expect(await service(config({ retention_keep_count: 10 })).prune('incremental')).toEqual({ removed: 0 });
    });

    it('is a no-op under DELETE_ON_SENT', async () => {
        for (let i = 1; i <= 12; i++) await row(`s${i}`, CaptureStatus.SENT, sentAt(i));
        expect(await service(config({ retention: 'DELETE_ON_SENT' })).prune('full')).toEqual({ removed: 0 });
    });

    it('a full pass reaches past the first page of 200; an incremental pass does not', async () => {
        const keys: string[] = [];
        for (let i = 1; i <= 215; i++) keys.push(await row(`s${String(i).padStart(3, '0')}`, CaptureStatus.SENT, sentAt(i)));
        const svc = service(config({ retention_keep_count: 5 }));
        expect(await svc.prune('incremental')).toEqual({ removed: 200 });
        expect(await exists(keys[0])).toBe(true);   // oldest, beyond the first page
        expect(await svc.prune('full')).toEqual({ removed: 10 });
        expect(await exists(keys[0])).toBe(false);
        for (const key of keys.slice(210)) expect(await exists(key)).toBe(true);
    });

    it('skips rows whose file is already gone', async () => {
        for (let i = 1; i <= 12; i++) await row(`s${i}`, CaptureStatus.SENT, sentAt(i));
        await fs.rm(path.join(root, 'ACC/s1.dcm'));
        expect(await service().prune('incremental')).toEqual({ removed: 1 });
    });
});
