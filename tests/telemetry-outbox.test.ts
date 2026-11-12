import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { GatewayConfig, TelemetryConfig } from '../src/config';
import { TelemetryOutbox } from '../src/application/services/TelemetryOutbox';
import { TelemetryService } from '../src/application/services/TelemetryService';
import type { TelemetryEventDto } from '../src/application/dto';
import { createDatabase } from '../src/infrastructure/database';
import { TelemetryEventEntity } from '../src/infrastructure/database/entities';
import { SettingRepository, TelemetryRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { phoneEvent } from './fixtures/telemetry';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let database: DataSource, repository: TelemetryRepository, config: GatewayConfig, outbox: TelemetryOutbox;
let freeBytes: number | null;
const disk = { freeBytes: jest.fn(async () => freeBytes) };
const DAY = 86_400_000;
const KB = 1024, MB = 1024 * 1024;

function row(daysAgo: number, payloadBytes = 100, overrides: Partial<TelemetryEventEntity> = {}): TelemetryEventEntity {
    const at = new Date(Date.now() - daysAgo * DAY).toISOString();
    return Object.assign(new TelemetryEventEntity(), {
        event_id: uuidv7(), schema_version: 1, type: 'device.health', occurred_at: at, received_at: at, site_id: 'VC1',
        gateway_id: 'g', device_id: null, session_id: null, capture_id: null, screening_id: null, authenticated: true,
        payload: JSON.stringify({ pad: 'x'.repeat(payloadBytes) }), sent_at: null, ...overrides,
    });
}
async function store(rows: TelemetryEventEntity[], sent: boolean) {
    const { bytes } = await repository.insert(rows);
    outbox.inserted(rows.length, bytes);
    if (sent) outbox.confirmed(await repository.markSentMeasured(rows.map(r => r.event_id), new Date().toISOString()));
    return rows;
}
const ids = async () => (await database.getRepository(TelemetryEventEntity).find()).map(r => r.event_id).sort();
function service() {
    return new TelemetryService(config, logger as never, repository, new SettingRepository(database), { kick: jest.fn() } as never, outbox);
}

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize(); await database.runMigrations();
    repository = new TelemetryRepository(database);
    freeBytes = 50 * 1024 * MB;
    config = Object.assign(new GatewayConfig(), {
        database_path: '/nonexistent/gateway.db', storage_root: '/nonexistent/captures',
        telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC1', max_outbox_mb: 64 / 1024, max_unsent_mb: 128 / 1024, retention_days: 90 }),
    });
    outbox = new TelemetryOutbox(config, logger as never, repository, disk as never);
    await outbox.start();
    outbox.stop();
});
afterEach(() => database.destroy());

test('deletes sent rows older than retention_days, and never an unsent one however old', async () => {
    config.telemetry.max_outbox_mb = 10; config.telemetry.max_unsent_mb = 20;
    await store([row(91)], true);
    const [oldUnsent] = await store([row(400)], false);
    const [recentSent] = await store([row(89)], true);
    await outbox.prune();
    expect(await ids()).toEqual([oldUnsent.event_id, recentSent.event_id].sort());
});

// The cap is the database's real size, so the space captures need is what is protected.
test('over the size cap, deletes sent rows oldest first until the database is under it', async () => {
    const baseline = await repository.databaseBytes();
    config.telemetry.max_outbox_mb = (baseline + 64 * KB) / MB;
    config.telemetry.max_unsent_mb = 10;
    const sent = await store([10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(d => row(d, 10 * KB)), true);
    const unsent = await store([row(20, 10 * KB), row(19, 10 * KB)], false);
    expect(await repository.databaseBytes()).toBeGreaterThan(baseline + 64 * KB);
    await outbox.prune();
    const left = await ids();
    for (const r of unsent) expect(left).toContain(r.event_id);
    const deleted = sent.filter(r => !left.includes(r.event_id)).map(r => r.event_id);
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted).toEqual(sent.slice(0, deleted.length).map(r => r.event_id));
    expect(await repository.databaseBytes()).toBeLessThanOrEqual(baseline + 64 * KB);
});

describe('admission as unsent rows grow', () => {
    const health = (authenticated: boolean) => ({ type: 'device.health', authenticated });

    test('normally everything is taken', () => {
        expect(outbox.accepts('device.health', false)).toBe(true);
        expect(outbox.accepts('app.crashed', true)).toBe(true);
    });

    test('past max_outbox_mb: unsigned rows and device.health are refused; signed crash, capture, AI and lifecycle rows are kept', async () => {
        await store(Array.from({ length: 7 }, (_, i) => row(i, 10 * KB)), false);
        expect(outbox.accepts('app.crashed', false)).toBe(false);
        expect(outbox.accepts(health(true).type, true)).toBe(false);
        for (const type of ['app.crashed', 'capture.taken', 'yolo.autocapture']) expect(outbox.accepts(type, true)).toBe(true);
        expect(outbox.accepts('ai.assessed', null)).toBe(true);
        expect(outbox.accepts('gateway.heartbeat', null)).toBe(true);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/max_outbox_mb.*without sign-in.*device\.health/));
    });

    test('past max_unsent_mb: only the gateway lifecycle is kept', async () => {
        await store(Array.from({ length: 14 }, (_, i) => row(i, 10 * KB)), false);
        for (const type of ['app.crashed', 'capture.taken']) expect(outbox.accepts(type, true)).toBe(false);
        expect(outbox.accepts('ai.assessed', null)).toBe(false);
        expect(outbox.accepts('gateway.heartbeat', null)).toBe(true);
        expect(logger.error).toHaveBeenLastCalledWith(expect.stringMatching(/max_unsent_mb.*lifecycle/));
    });

    test('once central confirms the backlog, everything is taken again', async () => {
        const rows = await store(Array.from({ length: 14 }, (_, i) => row(i, 10 * KB)), false);
        outbox.confirmed(await repository.markSentMeasured(rows.map(r => r.event_id), new Date().toISOString()));
        expect(outbox.accepts('device.health', false)).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/back under/));
    });

    test('ingest drops what is refused and lists it in dropped', async () => {
        await store(Array.from({ length: 7 }, (_, i) => row(i, 10 * KB)), false);
        const health1 = phoneEvent('device.health'), crash = phoneEvent('app.crashed'), taken = phoneEvent('capture.taken');
        const signed = await service().ingest([health1, crash, taken] as unknown as TelemetryEventDto[], true);
        expect(signed).toEqual({ accepted: [crash.event_id, taken.event_id], duplicate: [], dropped: [health1.event_id] });
        const unsignedCrash = phoneEvent('app.crashed');
        expect(await service().ingest([unsignedCrash] as unknown as TelemetryEventDto[], false)).toEqual({ accepted: [], duplicate: [], dropped: [unsignedCrash.event_id] });
    });

    // The reviewer's flood: unsigned crashes as fast as allowed, with central down. The
    // unsent rows stop near the first cap instead of filling the disk.
    test('a flood of unsigned events stops at the cap', async () => {
        const telemetry = service();
        for (let i = 0; i < 40; i++) {
            const crash = phoneEvent('app.crashed', { payload: { source: 'exit_info', app_version: '2.4.0', stack_frames: Array.from({ length: 20 }, () => ({ class: 'org.visilant.A'.padEnd(200, 'x'), method: 'run', file: 'A.kt', line: 1 })) } });
            await telemetry.ingest([crash] as unknown as TelemetryEventDto[], false);
        }
        const unsent = (await repository.unsentTotals()).bytes;
        expect(unsent).toBeGreaterThan(64 * KB);
        expect(unsent).toBeLessThan(64 * KB + 8 * KB);
    });
});

describe('free disk', () => {
    test('under min_free_disk_mb nothing is taken, not even the lifecycle, and it is logged once', async () => {
        freeBytes = 900 * MB;
        await outbox.refreshDisk(); await outbox.refreshDisk();
        expect(outbox.accepts('gateway.heartbeat', null)).toBe(false);
        expect(outbox.accepts('app.crashed', true)).toBe(false);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/less than 1024 MB free.*captures/));
        freeBytes = 5 * 1024 * MB;
        await outbox.refreshDisk();
        expect(outbox.accepts('gateway.heartbeat', null)).toBe(true);
    });

    test('checks the folders of the database and the captures', async () => {
        await outbox.refreshDisk();
        expect(disk.freeBytes).toHaveBeenLastCalledWith(['/nonexistent', '/nonexistent/captures']);
    });

    test('an unknown free space does not stop telemetry', async () => {
        freeBytes = null;
        await outbox.refreshDisk();
        expect(outbox.accepts('app.crashed', true)).toBe(true);
    });
});

test('keeps running unsent totals instead of counting on every request', async () => {
    const totals = jest.spyOn(repository, 'unsentTotals');
    const count = jest.spyOn(repository, 'countUnsent');
    const telemetry = service();
    for (let i = 0; i < 5; i++) await telemetry.ingest([phoneEvent('device.health')] as unknown as TelemetryEventDto[], true);
    await telemetry.record('gateway.heartbeat', {});
    expect(totals).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(outbox.unsentCount()).toBe(6);
    // And they agree with the table.
    expect((await repository.unsentTotals()).count).toBe(6);
});

test('start reads the totals once, prunes, and sets 10 min prune and 60 s disk timers, unref', async () => {
    await store([row(1)], false);
    const interval = jest.spyOn(global, 'setInterval');
    try {
        const [old] = await store([row(100)], true);
        const fresh = new TelemetryOutbox(config, logger as never, repository, disk as never);
        await fresh.start();
        expect(fresh.unsentCount()).toBe(1);
        expect(await ids()).not.toContain(old.event_id);
        expect(interval.mock.calls.map(c => c[1]).sort()).toEqual([60_000, 600_000]);
        for (const result of interval.mock.results) expect((result.value as NodeJS.Timeout).hasRef()).toBe(false);
        fresh.stop();
    } finally { interval.mockRestore(); }
});

test('a failed prune is logged, not thrown', async () => {
    await database.destroy();
    await expect(outbox.prune()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/telemetry prune/));
    await database.initialize();
});

// Deleting rows frees pages but does not shrink the file unless it can be vacuumed.
describe('reclaiming space', () => {
    let directory: string;
    beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'telemetry-vacuum-')); });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    test('an existing database is converted to incremental vacuum once, at start-up', async () => {
        const file = path.join(directory, 'gateway.db');
        const raw = new BetterSqlite3(file); raw.exec('CREATE TABLE legacy (a)'); expect(raw.pragma('auto_vacuum', { simple: true })).toBe(0); raw.close();
        const opened = await createDatabase({ database_path: file } as GatewayConfig, logger as never);
        expect((await opened.query('PRAGMA auto_vacuum'))[0].auto_vacuum).toBe(2);
        await opened.destroy();
        logger.info.mockClear();
        const again = await createDatabase({ database_path: file } as GatewayConfig, logger as never);
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringMatching(/incremental vacuum/));
        await again.destroy();
    });

    test('pruning gives freed pages back to the disk', async () => {
        const file = path.join(directory, 'gateway.db');
        const opened = await createDatabase({ database_path: file } as GatewayConfig, logger as never);
        const repo = new TelemetryRepository(opened);
        const box = new TelemetryOutbox(Object.assign(new GatewayConfig(), { database_path: file, storage_root: directory, telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC1' }) }), logger as never, repo, disk as never);
        const rows = Array.from({ length: 50 }, () => row(200, 20 * KB));
        await repo.insert(rows);
        await repo.markSentMeasured(rows.map(r => r.event_id), new Date().toISOString());
        const before = Number((await opened.query('PRAGMA page_count'))[0].page_count);
        await box.prune();
        const after = Number((await opened.query('PRAGMA page_count'))[0].page_count);
        expect(after).toBeLessThan(before / 2);
        expect(Number((await opened.query('PRAGMA freelist_count'))[0].freelist_count)).toBe(0);
        await opened.destroy();
    });
});
