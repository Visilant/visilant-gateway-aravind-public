import { DataSource } from 'typeorm';
import { GatewayConfig, TelemetryConfig } from '../src/config';
import { TelemetryService } from '../src/application/services/TelemetryService';
import { SyncWorker } from '../src/application/services/SyncWorker';
import type { TelemetryEventDto } from '../src/application/dto';
import { CaptureEntity, CaptureStatus, SettingEntity, TelemetryEventEntity } from '../src/infrastructure/database/entities';
import { CaptureRepository, SettingRepository, TelemetryRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { phoneEvent } from './fixtures/telemetry';
import { openOutbox } from './fixtures/outbox';

// TypeORM's better-sqlite3 driver has one connection. Two explicit transactions open at
// once collide, and the capture queue's claimDue is one of them. Telemetry writes come
// from every phone request and a timer, so they must never open a transaction.

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let database: DataSource, config: GatewayConfig, telemetry: TelemetryService, captures: CaptureRepository;
const events = (n: number) => Array.from({ length: n }, () => phoneEvent('device.health') as unknown as TelemetryEventDto);
const outbox = openOutbox();

function capture(id: string): CaptureEntity {
    return Object.assign(new CaptureEntity(), {
        id, dicom_path: `${id}.dcm`, status: CaptureStatus.PENDING, study_instance_uid: `1.2.3.${id.length}`,
        series_instance_uid: `1.2.3.${id}.1`, sop_instance_uid: `1.2.3.${id}.1.1`, accession_number: 'ACC', attempts: 0,
        next_attempt_at: null, last_error: null, created_by: null, created_at: new Date().toISOString(), sent_at: null,
    });
}

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize(); await database.runMigrations();
    config = Object.assign(new GatewayConfig(), { telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC1' }) });
    telemetry = new TelemetryService(config, logger as never, new TelemetryRepository(database), new SettingRepository(database), { kick: jest.fn() } as never, outbox as never);
    captures = new CaptureRepository(database);
});
afterEach(() => database.destroy());

test('concurrent first uses of gatewayId all get the same id, and only one is stored', async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, () => telemetry.gatewayId()));
    expect(new Set(ids).size).toBe(1);
    // A second instance (a restart) reads the stored one.
    const again = new TelemetryService(config, logger as never, new TelemetryRepository(database), new SettingRepository(database), { kick: jest.fn() } as never, outbox as never);
    expect(await again.gatewayId()).toBe(ids[0]);
    expect(await database.getRepository(SettingEntity).countBy({ key: 'telemetry.gateway_id' })).toBe(1);
});

test('concurrent ingests and gateway records all succeed', async () => {
    const results = await Promise.allSettled([
        ...Array.from({ length: 20 }, () => telemetry.ingest(events(2), true)),
        ...Array.from({ length: 20 }, () => telemetry.record('gateway.heartbeat', {})),
    ]);
    expect(results.filter(r => r.status === 'rejected')).toEqual([]);
    expect(await database.getRepository(TelemetryEventEntity).count()).toBe(60);
});

test.each(['claim-first', 'ingest-first'])('telemetry writes alongside claimDue (%s): both succeed and the claim is consistent', async (order) => {
    for (const id of ['c1', 'c2', 'c3']) await captures.create(capture(id));
    const claim = () => captures.claimDue(10, new Date(Date.now() + 1000).toISOString());
    const writes = () => [telemetry.ingest(events(3), true), telemetry.record('gateway.heartbeat', {}), telemetry.ingest(events(1), true)];
    const results = await Promise.allSettled(order === 'claim-first' ? [claim(), ...writes()] : [...writes(), claim()]);
    expect(results.filter(r => r.status === 'rejected')).toEqual([]);
    const claimed = results[order === 'claim-first' ? 0 : 3] as PromiseFulfilledResult<CaptureEntity[]>;
    expect(claimed.value.map(c => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect((await database.query(`SELECT status FROM capture`)).map((r: { status: string }) => r.status)).toEqual(['SENDING', 'SENDING', 'SENDING']);
});

test('captures keep reaching the archive while phones send telemetry', async () => {
    for (let i = 0; i < 12; i++) await captures.create(capture(`cap-${i}`));
    const store = { store: jest.fn(async () => { await new Promise(r => setImmediate(r)); }) };
    const storage = { exists: async () => true, remove: async () => undefined, absolutePath: (k: string) => `/tmp/${k}` };
    const sync = new SyncWorker({ retention: 'DELETE_ON_SENT', max_send_attempts: 3, store: {} } as GatewayConfig, logger as never, captures, store as never, storage as never, { prune: jest.fn() } as never);
    const noise = Array.from({ length: 30 }, (_, i) => i % 3 === 0 ? telemetry.record('gateway.heartbeat', {}) : telemetry.ingest(events(2), true));
    const results = await Promise.allSettled([sync.tick(), ...noise, sync.tick()]);
    expect(results.filter(r => r.status === 'rejected')).toEqual([]);
    await sync.tick();
    expect((await captures.countByStatus())).toMatchObject({ SENT: 12, SENDING: 0, PENDING: 0, FAILED: 0 });
});
