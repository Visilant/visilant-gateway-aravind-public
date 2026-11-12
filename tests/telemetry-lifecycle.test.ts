import { DataSource } from 'typeorm';
import { GatewayConfig, TelemetryConfig } from '../src/config';
import { TelemetryLifecycle } from '../src/application/services/TelemetryLifecycle';
import { TelemetryService } from '../src/application/services/TelemetryService';
import { TelemetryEventEntity } from '../src/infrastructure/database/entities';
import { SettingRepository, TelemetryRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import pkg from '../package.json';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let database: DataSource;
let config: GatewayConfig;

function lifecycle(): TelemetryLifecycle {
    const repository = new TelemetryRepository(database);
    const telemetry = new TelemetryService(config, logger as never, repository, new SettingRepository(database), { kick: jest.fn() } as never);
    return new TelemetryLifecycle(config, logger as never, telemetry, repository);
}
const events = () => database.getRepository(TelemetryEventEntity).find({ order: { event_id: 'ASC' } });
const types = async () => (await events()).map(e => e.type);

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize();
    await database.runMigrations();
    config = Object.assign(new GatewayConfig(), { telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC1' }) });
});
afterEach(() => database.destroy());

test('first start writes gateway.started with version, uptime and backlog, and no unclean shutdown', async () => {
    const gateway = lifecycle();
    await gateway.start();
    gateway.stopTimer();
    const [started] = await events();
    expect(started).toMatchObject({ type: 'gateway.started', device_id: null, session_id: null, site_id: 'VC1' });
    expect(JSON.parse(started.payload)).toEqual({ gateway_version: pkg.version, uptime_s: expect.any(Number), outbox_backlog: 0 });
});

test('a heartbeat carries the outbox backlog', async () => {
    const gateway = lifecycle();
    await gateway.start();
    gateway.stopTimer();
    await gateway.heartbeat();
    const heartbeat = (await events()).find(e => e.type === 'gateway.heartbeat')!;
    expect(JSON.parse(heartbeat.payload)).toEqual({ gateway_version: pkg.version, uptime_s: expect.any(Number), outbox_backlog: 1 });
});

test('a clean stop then a start is not an unclean shutdown', async () => {
    const first = lifecycle();
    await first.start(); await first.heartbeat(); await first.stop();
    await lifecycle().start();
    expect(await types()).toEqual(['gateway.started', 'gateway.heartbeat', 'gateway.stopped', 'gateway.started']);
});

test('a heartbeat with no stop after it means the last run ended without a shutdown', async () => {
    const first = lifecycle();
    await first.start(); await first.heartbeat(); first.stopTimer(); // power cut: no stop
    const heartbeat = (await events()).find(e => e.type === 'gateway.heartbeat')!;
    const second = lifecycle();
    await second.start(); second.stopTimer();
    expect(await types()).toEqual(['gateway.started', 'gateway.heartbeat', 'gateway.unclean_shutdown', 'gateway.started']);
    const unclean = JSON.parse((await events())[2].payload);
    expect(unclean).toEqual({ last_heartbeat_at: heartbeat.occurred_at, restarted_at: expect.any(String), downtime_s: expect.any(Number) });
    expect(unclean.restarted_at >= heartbeat.occurred_at).toBe(true);
    expect(unclean.downtime_s).toBeGreaterThanOrEqual(0);
});

// A power cut in the first minute leaves gateway.started as the newest row.
test('a start with no stop after it is also an unclean shutdown', async () => {
    const first = lifecycle();
    await first.start(); first.stopTimer();
    await lifecycle().start();
    expect(await types()).toEqual(['gateway.started', 'gateway.unclean_shutdown', 'gateway.started']);
});

test('phone rows do not hide the lifecycle', async () => {
    const first = lifecycle();
    await first.start(); await first.stop();
    await database.getRepository(TelemetryEventEntity).insert(Object.assign(new TelemetryEventEntity(), {
        event_id: '01a1d134-9809-7fff-8061-ffdbd6319aa9', schema_version: 1, type: 'device.health', occurred_at: new Date().toISOString(),
        received_at: new Date().toISOString(), site_id: 'VC1', gateway_id: 'g', device_id: '7d0c3f0e-1b7a-4c8e-9a51-2f3b4c5d6e7f', session_id: null,
        capture_id: null, screening_id: null, payload: '{}', sent_at: null,
    }));
    await lifecycle().start();
    expect(await types()).not.toContain('gateway.unclean_shutdown');
});

test('beats every 60 seconds on an unref timer, and stop clears it', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    try {
        const gateway = lifecycle();
        await gateway.start();
        expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
        const timer = interval.mock.results[0].value as NodeJS.Timeout;
        expect(timer.hasRef()).toBe(false);
        await gateway.stop();
    } finally { interval.mockRestore(); }
});

test('telemetry off: no rows and no timer', async () => {
    config.telemetry.enabled = false;
    const interval = jest.spyOn(global, 'setInterval');
    try {
        const gateway = lifecycle();
        await gateway.start(); await gateway.heartbeat(); await gateway.stop();
        expect(interval).not.toHaveBeenCalled();
        expect(await events()).toEqual([]);
    } finally { interval.mockRestore(); }
});

test('a failed heartbeat is logged, not thrown', async () => {
    const gateway = lifecycle();
    await gateway.start(); gateway.stopTimer();
    await database.destroy();
    await expect(gateway.heartbeat()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/telemetry heartbeat/));
    await database.initialize();
});
