import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { GatewayConfig, TelemetryConfig } from '../src/config';
import { TelemetryOutbox } from '../src/application/services/TelemetryOutbox';
import { TelemetryService } from '../src/application/services/TelemetryService';
import type { TelemetryEventDto } from '../src/application/dto';
import { TelemetryEventEntity } from '../src/infrastructure/database/entities';
import { SettingRepository, TelemetryRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { phoneEvent } from './fixtures/telemetry';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let database: DataSource, repository: TelemetryRepository, config: GatewayConfig, outbox: TelemetryOutbox;
const DAY = 86_400_000;
const KB = 1024;

function row(daysAgo: number, payloadBytes = 100): TelemetryEventEntity {
    const at = new Date(Date.now() - daysAgo * DAY).toISOString();
    return Object.assign(new TelemetryEventEntity(), {
        event_id: uuidv7(), schema_version: 1, type: 'device.health', occurred_at: at, received_at: at, site_id: 'VC1',
        gateway_id: 'g', device_id: null, session_id: null, capture_id: null, screening_id: null,
        payload: JSON.stringify({ pad: 'x'.repeat(payloadBytes) }), sent_at: null,
    });
}
async function store(rows: TelemetryEventEntity[], sent: boolean) {
    await repository.insertOrIgnore(rows);
    if (sent) await repository.markSent(rows.map(r => r.event_id), new Date().toISOString());
    return rows;
}
const ids = async () => (await database.getRepository(TelemetryEventEntity).find()).map(r => r.event_id).sort();

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize(); await database.runMigrations();
    repository = new TelemetryRepository(database);
    // 64 KB, so a handful of 10 KB rows fills it.
    config = Object.assign(new GatewayConfig(), { telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC1', max_outbox_mb: 64 / 1024, retention_days: 90 }) });
    outbox = new TelemetryOutbox(config, logger as never, repository);
});
afterEach(() => database.destroy());

test('deletes sent rows older than retention_days, and never an unsent one however old', async () => {
    await store([row(91)], true);
    const [oldUnsent] = await store([row(400)], false);
    const [recentSent] = await store([row(89)], true);
    await outbox.prune();
    expect(await ids()).toEqual([oldUnsent.event_id, recentSent.event_id].sort());
});

test('over the size cap, deletes sent rows oldest first until under it', async () => {
    const sent = await store([5, 4, 3, 2, 1].map(d => row(d, 10 * KB)), true);
    const unsent = await store([row(10, 10 * KB), row(9, 10 * KB)], false);
    await outbox.prune();
    const left = await ids();
    for (const r of unsent) expect(left).toContain(r.event_id);
    // Whatever went is the oldest sent rows, in order, and the newest sent row stays.
    const deleted = sent.filter(r => !left.includes(r.event_id)).map(r => r.event_id);
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted).toEqual(sent.slice(0, deleted.length).map(r => r.event_id));
    expect(left).toContain(sent[4].event_id);
    expect((await repository.sizes()).total_bytes).toBeLessThanOrEqual(64 * KB);
    expect(outbox.acceptsDeviceHealth()).toBe(true);
});

test('when unsent rows alone pass the cap: logs an error once, deletes nothing unsent and stops taking device.health', async () => {
    const unsent = await store(Array.from({ length: 8 }, (_, i) => row(i, 10 * KB)), false);
    await store([row(1, 10 * KB)], true);
    await outbox.prune();
    await outbox.prune();
    expect(await ids()).toEqual(unsent.map(r => r.event_id).sort());
    expect(outbox.acceptsDeviceHealth()).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/unsent.*device\.health/));

    // Central catches up: the rows are sent, pruned, and device.health is taken again.
    await repository.markSent(unsent.map(r => r.event_id), new Date().toISOString());
    await outbox.prune();
    expect(outbox.acceptsDeviceHealth()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/device\.health/));
});

test('while full, ingest drops device.health but keeps crash, capture and other rows', async () => {
    await store(Array.from({ length: 8 }, (_, i) => row(i, 10 * KB)), false);
    await outbox.prune();
    const telemetry = new TelemetryService(config, logger as never, repository, new SettingRepository(database), { kick: jest.fn() } as never, outbox);
    const health = phoneEvent('device.health'), crash = phoneEvent('app.crashed'), taken = phoneEvent('capture.taken');
    const result = await telemetry.ingest([health, crash, taken] as unknown as TelemetryEventDto[], true);
    expect(result).toEqual({ accepted: [crash.event_id, taken.event_id], duplicate: [], dropped: [health.event_id] });
    expect(await ids()).not.toContain(health.event_id);
});

test('prunes at start and every 10 minutes on an unref timer', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    try {
        const [old] = await store([row(100)], true);
        await outbox.start();
        expect(await ids()).not.toContain(old.event_id);
        expect(interval).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000);
        expect((interval.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);
        outbox.stop();
    } finally { interval.mockRestore(); }
});

test('a failed prune is logged, not thrown', async () => {
    await database.destroy();
    await expect(outbox.prune()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/telemetry prune/));
    await database.initialize();
});
