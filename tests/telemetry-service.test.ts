import { DataSource } from 'typeorm';
import { GatewayConfig, TelemetryConfig } from '../src/config';
import { TelemetryService, TelemetrySignInRequiredError } from '../src/application/services/TelemetryService';
import type { TelemetryEventDto } from '../src/application/dto';
import { SettingRepository, TelemetryRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { phoneEvent } from './fixtures/telemetry';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const push = { kick: jest.fn().mockResolvedValue(undefined) };
let database: DataSource, service: TelemetryService, config: GatewayConfig;
const health = (n: number) => Array.from({ length: n }, () => phoneEvent('device.health') as unknown as TelemetryEventDto);

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize(); await database.runMigrations();
    config = Object.assign(new GatewayConfig(), { telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC1' }) });
    service = new TelemetryService(config, logger as never, new TelemetryRepository(database), new SettingRepository(database), push as never, { acceptsDeviceHealth: () => true } as never);
});
afterEach(() => database.destroy());

test('pushes right away once the unsent backlog reaches a full batch of 500', async () => {
    for (let i = 0; i < 4; i++) await service.ingest(health(100), true);
    await service.record('gateway.heartbeat', {});
    expect(push.kick).not.toHaveBeenCalled();
    await service.ingest(health(99), true);
    expect(push.kick).toHaveBeenCalledTimes(1);
});

test('a batch of only duplicates does not trigger a push', async () => {
    const events = health(100);
    for (let i = 0; i < 5; i++) await service.ingest(health(100), true);
    push.kick.mockClear();
    await service.ingest(events, true);
    expect(push.kick).toHaveBeenCalledTimes(1);
    push.kick.mockClear();
    await service.ingest(events, true);
    expect(push.kick).not.toHaveBeenCalled();
});

test('gateway_id is generated once and survives a new service instance', async () => {
    const first = await service.gatewayId();
    const again = new TelemetryService(config, logger as never, new TelemetryRepository(database), new SettingRepository(database), push as never, { acceptsDeviceHealth: () => true } as never);
    expect(await again.gatewayId()).toBe(first);
});

test('record does nothing while telemetry is off', async () => {
    config.telemetry.enabled = false;
    expect(await service.record('gateway.heartbeat', {})).toBeNull();
    expect(await new TelemetryRepository(database).countUnsent()).toBe(0);
});

test('without sign-in, a batch with a capture type is refused whole and stores nothing', async () => {
    const batch = [phoneEvent('device.health'), phoneEvent('yolo.autocapture')] as unknown as TelemetryEventDto[];
    await expect(service.ingest(batch, false)).rejects.toEqual(new TelemetrySignInRequiredError('yolo.autocapture'));
    expect(await new TelemetryRepository(database).countUnsent()).toBe(0);
    expect((await service.ingest([batch[0]], false)).accepted).toHaveLength(1);
});
