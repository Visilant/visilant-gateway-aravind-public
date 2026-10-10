import { DataSource } from 'typeorm';
import type { GatewayConfig } from '../src/config';
import { SyncWorker } from '../src/application/services/SyncWorker';
import { CaptureEntity, CaptureStatus } from '../src/infrastructure/database/entities';
import { CaptureRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

let database: DataSource;
let repository: CaptureRepository;

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
    return {
        retention: 'DELETE_ON_SENT',
        max_send_attempts: 3,
        sync_interval_seconds: 30,
        store: { host: 'h', port: 104, called_ae: 'A', calling_ae: 'B' },
        ...overrides,
    } as GatewayConfig;
}

async function queue(id: string, attempts = 0, nextAttemptAt: string | null = null) {
    return database.getRepository(CaptureEntity).save(Object.assign(new CaptureEntity(), {
        id,
        dicom_path: `ACC1/${id}.dcm`,
        status: CaptureStatus.PENDING,
        study_instance_uid: '1.2.3',
        series_instance_uid: '1.2.3.1',
        sop_instance_uid: `1.2.3.1.${id}`,
        accession_number: 'ACC1',
        attempts,
        next_attempt_at: nextAttemptAt,
        last_error: null,
        created_by: null,
        created_at: new Date().toISOString(),
        sent_at: null,
    }));
}

function worker(opts: {
    store?: jest.Mock;
    exists?: jest.Mock;
    remove?: jest.Mock;
    config?: GatewayConfig;
}) {
    const storeClient = { store: opts.store ?? jest.fn().mockResolvedValue(undefined) };
    const storage = {
        exists: opts.exists ?? jest.fn().mockResolvedValue(true),
        remove: opts.remove ?? jest.fn().mockResolvedValue(undefined),
        absolutePath: (key: string) => `/tmp/${key}`,
    };
    const retention = { prune: jest.fn().mockResolvedValue({ removed: 0 }) };
    const sync = new SyncWorker(
        opts.config ?? config(), logger as never, repository, storeClient as never, storage as never, retention as never
    );
    return { sync, storeClient, storage, retention };
}

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize();
    await database.runMigrations();
    repository = new CaptureRepository(database);
});

afterEach(async () => { await database.destroy(); });

describe('successful send', () => {
    it('marks the capture SENT and stamps sent_at', async () => {
        await queue('a');
        const { sync } = worker({});

        expect(await sync.tick()).toEqual({ sent: 1, failed: 0 });

        const row = await repository.findById('a');
        expect(row?.status).toBe(CaptureStatus.SENT);
        expect(row?.sent_at).toBeTruthy();
    });

    // Deleting before the archive acknowledges would lose the photograph outright.
    it('removes the local file only after the archive acknowledges', async () => {
        await queue('a');
        const remove = jest.fn().mockResolvedValue(undefined);
        const order: string[] = [];
        const store = jest.fn().mockImplementation(async () => { order.push('store'); });
        remove.mockImplementation(async () => { order.push('remove'); });

        const { sync } = worker({ store, remove });
        await sync.tick();

        expect(order).toEqual(['store', 'remove']);
    });

    it('keeps the local file when retention is KEEP', async () => {
        await queue('a');
        const remove = jest.fn();
        const { sync } = worker({ remove, config: config({ retention: 'KEEP' }) });

        await sync.tick();
        expect(remove).not.toHaveBeenCalled();
    });

    // A file that cannot be deleted is an operational annoyance, not a reason to
    // re-send an image the archive already holds.
    it('still counts as sent when the local delete fails', async () => {
        await queue('a');
        const remove = jest.fn().mockRejectedValue(new Error('EBUSY'));
        const { sync } = worker({ remove });

        expect(await sync.tick()).toEqual({ sent: 1, failed: 0 });
        expect((await repository.findById('a'))?.status).toBe(CaptureStatus.SENT);
    });
});

describe('failed send', () => {
    it('returns the capture to PENDING with a backoff and the real error', async () => {
        await queue('a');
        const store = jest.fn().mockRejectedValue(new Error('DICOM C-STORE failed: Connection refused'));
        const { sync } = worker({ store });

        expect(await sync.tick()).toEqual({ sent: 0, failed: 1 });

        const row = await repository.findById('a');
        expect(row?.status).toBe(CaptureStatus.PENDING);
        expect(row?.attempts).toBe(1);
        expect(row?.next_attempt_at).toBeTruthy();
        expect(row?.last_error).toMatch(/Connection refused/);
    });

    it('does not delete the local file on failure', async () => {
        await queue('a');
        const remove = jest.fn();
        const { sync } = worker({ store: jest.fn().mockRejectedValue(new Error('nope')), remove });

        await sync.tick();
        expect(remove).not.toHaveBeenCalled();
    });

    it('backs off further with each attempt', async () => {
        await queue('a');
        const store = jest.fn().mockRejectedValue(new Error('nope'));
        // Headroom, so the second attempt schedules a retry instead of being parked.
        const { sync } = worker({ store, config: config({ max_send_attempts: 10 }) });

        await sync.tick();
        const first = await repository.findById('a');

        await repository.requeue('a');
        await database.getRepository(CaptureEntity).update('a', { attempts: 2 });
        await sync.tick();
        const later = await repository.findById('a');

        expect(new Date(later!.next_attempt_at!).getTime())
            .toBeGreaterThan(new Date(first!.next_attempt_at!).getTime());
    });

    it('parks the capture as FAILED once attempts are exhausted', async () => {
        await queue('a', 2); // max_send_attempts is 3 in this config
        const { sync } = worker({ store: jest.fn().mockRejectedValue(new Error('nope')) });

        await sync.tick();

        const row = await repository.findById('a');
        expect(row?.status).toBe(CaptureStatus.FAILED);
        expect(row?.next_attempt_at).toBeNull();
    });

    // Retrying cannot conjure the file back, so this is terminal on the first attempt.
    it('fails immediately and permanently when the DICOM file is gone', async () => {
        await queue('a');
        const store = jest.fn();
        const { sync } = worker({ store, exists: jest.fn().mockResolvedValue(false) });

        await sync.tick();

        const row = await repository.findById('a');
        expect(row?.status).toBe(CaptureStatus.FAILED);
        expect(row?.last_error).toMatch(/missing from local storage/);
        expect(store).not.toHaveBeenCalled();
    });
});

describe('claiming', () => {
    it('leaves captures whose backoff has not elapsed', async () => {
        await queue('soon', 1, new Date(Date.now() + 60_000).toISOString());
        await queue('due', 1, new Date(Date.now() - 60_000).toISOString());
        const store = jest.fn().mockResolvedValue(undefined);
        const { sync } = worker({ store });

        expect(await sync.tick()).toEqual({ sent: 1, failed: 0 });
        expect((await repository.findById('soon'))?.status).toBe(CaptureStatus.PENDING);
        expect((await repository.findById('due'))?.status).toBe(CaptureStatus.SENT);
    });

    it('ignores captures that are already SENT or FAILED', async () => {
        await queue('a');
        await repository.markSent('a', new Date().toISOString());
        const store = jest.fn();
        const { sync } = worker({ store });

        expect(await sync.tick()).toEqual({ sent: 0, failed: 0 });
        expect(store).not.toHaveBeenCalled();
    });

    // A slow archive must not let the next interval pick up rows the current tick is
    // still working through.
    it('does not process the same capture twice when ticks overlap', async () => {
        await queue('a');
        let release: () => void = () => undefined;
        let inFlight: () => void = () => undefined;
        const storeCalled = new Promise<void>((resolve) => { inFlight = resolve; });
        const store = jest.fn().mockImplementation(() => new Promise<void>((r) => {
            release = r;
            inFlight();
        }));
        const { sync } = worker({ store });

        const first = sync.tick();
        await storeCalled;                  // the first tick is now mid-send
        const second = await sync.tick();   // fires while the first is still in flight
        release();
        await first;

        expect(second).toEqual({ sent: 0, failed: 0 });
        expect(store).toHaveBeenCalledTimes(1);
    });
});

describe('retention KEEP', () => {
    it('prunes incrementally after a successful send, not after a failure, and never removes the file itself', async () => {
        await queue('a');
        await queue('b');
        const store = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('DICOM C-STORE failed: refused'));
        const { sync, storage, retention } = worker({ store, config: config({ retention: 'KEEP', retention_keep_count: 10 }) });
        await sync.tick();
        expect(retention.prune).toHaveBeenCalledTimes(1);
        expect(retention.prune).toHaveBeenCalledWith('incremental');
        expect(storage.remove).not.toHaveBeenCalled();
    });

    it('does not prune under DELETE_ON_SENT', async () => {
        await queue('a');
        const { sync, storage, retention } = worker({});
        await sync.tick();
        expect(retention.prune).not.toHaveBeenCalled();
        expect(storage.remove).toHaveBeenCalledTimes(1);
    });
});
