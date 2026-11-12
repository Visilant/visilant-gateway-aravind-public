import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { TelemetryEventEntity } from '../src/infrastructure/database/entities';
import { TelemetryRepository } from '../src/infrastructure/database/repositories';

let database: DataSource;
let repository: TelemetryRepository;

function row(overrides: Partial<TelemetryEventEntity> = {}): TelemetryEventEntity {
    const now = new Date().toISOString();
    return Object.assign(new TelemetryEventEntity(), {
        event_id: uuidv7(), schema_version: 1, type: 'device.health', occurred_at: now, received_at: now,
        site_id: 'VC1', gateway_id: '00000000-0000-4000-8000-000000000001', device_id: null, session_id: null,
        capture_id: null, screening_id: null, payload: '{}', sent_at: null, ...overrides,
    });
}

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize();
    await database.runMigrations();
    repository = new TelemetryRepository(database);
});
afterEach(() => database.destroy());

test('insertOrIgnore reports which rows were new, and ignores a repeated event_id', async () => {
    const a = row(); const b = row();
    expect(await repository.insertOrIgnore([a, b])).toEqual([true, true]);
    expect(await repository.insertOrIgnore([b, row({ event_id: a.event_id, type: 'app.started' }), row()])).toEqual([false, false, true]);
    expect(await repository.countUnsent()).toBe(3);
    // The first copy wins; a retry never overwrites it.
    expect((await database.getRepository(TelemetryEventEntity).findOneByOrFail({ event_id: a.event_id })).type).toBe('device.health');
});

test('the same event_id twice in one batch is stored once', async () => {
    const a = row();
    expect(await repository.insertOrIgnore([a, { ...a }])).toEqual([true, false]);
});

test('findUnsent returns unsent rows in event_id order, up to the limit', async () => {
    const rows = [row(), row(), row(), row()];
    await repository.insertOrIgnore([rows[2], rows[0], rows[3], rows[1]]);
    await repository.markSent([rows[1].event_id], new Date().toISOString());
    expect((await repository.findUnsent(2)).map(r => r.event_id)).toEqual([rows[0].event_id, rows[2].event_id]);
});

test('findUnsent after a cursor pages through unsent rows only', async () => {
    const rows = [row(), row(), row()];
    await repository.insertOrIgnore(rows);
    await repository.markSent([rows[2].event_id], new Date().toISOString());
    expect((await repository.findUnsent(10, rows[0].event_id)).map(r => r.event_id)).toEqual([rows[1].event_id]);
});

test('markSent touches only the ids given and only rows not already sent', async () => {
    const rows = [row(), row(), row()];
    await repository.insertOrIgnore(rows);
    expect(await repository.markSent([rows[0].event_id, rows[1].event_id, uuidv7()], '2026-11-12T00:00:00.000Z')).toBe(2);
    expect(await repository.markSent([rows[0].event_id], '2026-11-13T00:00:00.000Z')).toBe(0);
    const stored = await database.getRepository(TelemetryEventEntity).find({ order: { event_id: 'ASC' } });
    expect(stored.map(r => r.sent_at)).toEqual(['2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z', null]);
});

test('newestLifecycle finds the newest gateway start, heartbeat or stop, ignoring phone and other gateway rows', async () => {
    expect(await repository.newestLifecycle()).toBeNull();
    const started = row({ type: 'gateway.started' });
    const heartbeat = row({ type: 'gateway.heartbeat' });
    await repository.insertOrIgnore([started, heartbeat, row({ type: 'gateway.unclean_shutdown' }), row({ type: 'ai.assessed' }), row()]);
    expect((await repository.newestLifecycle())?.event_id).toBe(heartbeat.event_id);
});

test('sizes estimates total and unsent bytes from the stored text', async () => {
    const empty = await repository.sizes();
    expect(empty).toEqual({ total_bytes: 0, unsent_bytes: 0 });
    const big = row({ payload: JSON.stringify({ x: 'y'.repeat(10_000) }) });
    await repository.insertOrIgnore([big, row()]);
    await repository.markSent([big.event_id], new Date().toISOString());
    const sizes = await repository.sizes();
    expect(sizes.total_bytes).toBeGreaterThan(10_000);
    expect(sizes.unsent_bytes).toBeLessThan(1_000);
    expect(sizes.unsent_bytes).toBeGreaterThan(0);
});

test('deleteSentBefore removes only sent rows that occurred before the cutoff', async () => {
    const oldSent = row({ occurred_at: '2026-01-01T00:00:00.000Z' });
    const oldUnsent = row({ occurred_at: '2026-01-01T00:00:00.000Z' });
    const newSent = row({ occurred_at: '2026-11-01T00:00:00.000Z' });
    await repository.insertOrIgnore([oldSent, oldUnsent, newSent]);
    await repository.markSent([oldSent.event_id, newSent.event_id], '2026-11-02T00:00:00.000Z');
    expect(await repository.deleteSentBefore('2026-06-01T00:00:00.000Z')).toBe(1);
    const left = (await database.getRepository(TelemetryEventEntity).find()).map(r => r.event_id).sort();
    expect(left).toEqual([oldUnsent.event_id, newSent.event_id].sort());
});

test('deleteOldestSent removes sent rows oldest first and never an unsent one', async () => {
    const a = row({ occurred_at: '2026-01-01T00:00:00.000Z' });
    const b = row({ occurred_at: '2026-01-02T00:00:00.000Z' });
    const c = row({ occurred_at: '2026-01-03T00:00:00.000Z' });
    const unsent = row({ occurred_at: '2025-01-01T00:00:00.000Z' });
    await repository.insertOrIgnore([c, a, b, unsent]);
    await repository.markSent([a.event_id, b.event_id, c.event_id], new Date().toISOString());
    expect(await repository.deleteOldestSent(2)).toBe(2);
    expect((await database.getRepository(TelemetryEventEntity).find()).map(r => r.event_id).sort()).toEqual([c.event_id, unsent.event_id].sort());
    expect(await repository.deleteOldestSent(10)).toBe(1);
    expect(await repository.deleteOldestSent(10)).toBe(0);
    expect(await repository.countUnsent()).toBe(1);
});
