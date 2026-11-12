import { createServer, type IncomingMessage, type Server } from 'http';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { GatewayConfig, TelemetryConfig } from '../src/config';
import { TelemetryPushWorker, pushBackoffMs } from '../src/application/services/TelemetryPushWorker';
import { CentralClient } from '../src/infrastructure/telemetry';
import { TelemetryEventEntity } from '../src/infrastructure/database/entities';
import { TelemetryRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { openOutbox } from './fixtures/outbox';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let database: DataSource, repository: TelemetryRepository, config: GatewayConfig;
let central: Server, centralUrl: string;
let requests: Array<{ method?: string; url?: string; authorization?: string; body: any }>;
// What central answers. Default: store everything and return every id.
let reply: (body: any) => { status: number; body: unknown };

function row(overrides: Partial<TelemetryEventEntity> = {}): TelemetryEventEntity {
    const now = new Date().toISOString();
    return Object.assign(new TelemetryEventEntity(), {
        event_id: uuidv7(), schema_version: 1, type: 'device.health', occurred_at: now, received_at: now, site_id: 'VC1',
        gateway_id: '0b8a9c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d', device_id: '7d0c3f0e-1b7a-4c8e-9a51-2f3b4c5d6e7f', session_id: null,
        capture_id: null, screening_id: null, authenticated: true, payload: '{"battery_pct":50}', sent_at: null, ...overrides,
    });
}
async function seed(count: number): Promise<TelemetryEventEntity[]> {
    const rows = Array.from({ length: count }, () => row());
    await repository.insertOrIgnore(rows);
    return rows;
}
const unsent = () => repository.countUnsent();
function worker(): TelemetryPushWorker {
    return new TelemetryPushWorker(config, logger as never, repository, new CentralClient(), openOutbox() as never);
}

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize(); await database.runMigrations();
    repository = new TelemetryRepository(database);
    requests = [];
    reply = (body) => ({ status: 200, body: { event_ids: body.events.map((e: { event_id: string }) => e.event_id) } });
    central = createServer(async (req: IncomingMessage, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
        const answer = reply(body);
        res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
    await new Promise<void>(resolve => central.listen(0, '127.0.0.1', resolve));
    centralUrl = `http://127.0.0.1:${(central.address() as { port: number }).port}`;
    config = Object.assign(new GatewayConfig(), { telemetry: Object.assign(new TelemetryConfig(), { enabled: true, site_id: 'VC1', central_url: centralUrl, central_token: 'SYNTHETIC-TOKEN' }) });
});
afterEach(async () => {
    jest.restoreAllMocks();
    await new Promise<void>(resolve => central.close(() => resolve()));
    await database.destroy();
});

test('posts unsent rows in event_id order to /v1/telemetry/batch with the gateway token, in the envelope', async () => {
    const [a, b] = await seed(2);
    expect(await worker().tick()).toEqual({ sent: 2 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/v1/telemetry/batch', authorization: 'Bearer SYNTHETIC-TOKEN' });
    expect(requests[0].body.events.map((e: { event_id: string }) => e.event_id)).toEqual([a.event_id, b.event_id]);
    // The same envelope as everywhere else, with the payload as an object. sent_at never leaves.
    const { sent_at: _s, seq: _q, push_attempts: _p, quarantined_at: _qa, quarantine_reason: _qr, ...envelope } = a;
    expect(requests[0].body.events[0]).toEqual({ ...envelope, payload: { battery_pct: 50 } });
    expect(await unsent()).toBe(0);
});

test('a central_url with a path or a trailing slash still reaches /v1/telemetry/batch under it', async () => {
    config.telemetry.central_url = `${centralUrl}/ingest/`;
    await seed(1);
    await worker().tick();
    expect(requests[0].url).toBe('/ingest/v1/telemetry/batch');
});

test('marks sent only the ids central returns that were in the batch', async () => {
    const rows = await seed(3);
    reply = () => ({ status: 200, body: { event_ids: [rows[0].event_id, rows[2].event_id, uuidv7()] } });
    expect(await worker().tick()).toEqual({ sent: 2 });
    expect((await repository.findUnsent(10)).map(r => r.event_id)).toEqual([rows[1].event_id]);
});

test('drains a backlog in batches of at most 500', async () => {
    await seed(1201);
    expect(await worker().tick()).toEqual({ sent: 1201 });
    expect(requests.map(r => r.body.events.length)).toEqual([500, 500, 201]);
});

test('does nothing with an empty outbox', async () => {
    expect(await worker().tick()).toEqual({ sent: 0 });
    expect(requests).toEqual([]);
});

test('an HTTP failure keeps the rows, logs the status and backs off before trying again', async () => {
    await seed(2);
    reply = () => ({ status: 503, body: { error: 'synthetic outage' } });
    const push = worker();
    let now = 1_000_000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    expect(await push.tick()).toEqual({ sent: 0 });
    expect(await unsent()).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/HTTP 503.*retrying in 1 min/));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SYNTHETIC-TOKEN');

    now += 59_000;
    await push.tick();
    expect(requests).toHaveLength(1);
    now += 2_000;
    await push.tick();
    expect(requests).toHaveLength(2);
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringMatching(/retrying in 2 min/));

    reply = (body) => ({ status: 200, body: { event_ids: body.events.map((e: { event_id: string }) => e.event_id) } });
    now += 120_000;
    expect(await push.tick()).toEqual({ sent: 2 });
    // Success resets the backoff.
    await seed(1);
    expect(await push.tick()).toEqual({ sent: 1 });
});

test('backoff doubles from 1 min to a 30 min ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(n => pushBackoffMs(n) / 60_000)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
});

test('a network failure logs the error code', async () => {
    await seed(1);
    // A port that was free a moment ago: nothing listens there.
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    config.telemetry.central_url = `http://127.0.0.1:${port}`;
    await worker().tick();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/ECONNREFUSED/));
    expect(await unsent()).toBe(1);
});

test('a reply without event_ids is a failure and marks nothing', async () => {
    await seed(1);
    reply = () => ({ status: 200, body: 'not json' });
    await worker().tick();
    expect(await unsent()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/event_ids/));
});

test('a reply that confirms none of a full batch stops the tick instead of resending it in a loop', async () => {
    await seed(600);
    reply = () => ({ status: 200, body: { event_ids: [] } });
    expect(await worker().tick()).toEqual({ sent: 0 });
    expect(requests).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/confirmed none/));
});

test('overlapping ticks never send the same rows twice at once', async () => {
    await seed(3);
    const push = worker();
    // The second caller shares the push already running.
    const [first, second] = await Promise.all([push.tick(), push.tick()]);
    expect(first).toEqual({ sent: 3 });
    expect(second).toBe(first);
    expect(requests).toHaveLength(1);
    expect(await unsent()).toBe(0);
});

test('starts a 60 s unref timer only when telemetry is on and central is configured', () => {
    const interval = jest.spyOn(global, 'setInterval');
    const push = worker();
    push.start();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect((interval.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);
    push.stop();

    interval.mockClear();
    config.telemetry.central_url = undefined; config.telemetry.central_token = undefined;
    worker().start();
    config.telemetry.enabled = false;
    worker().start();
    expect(interval).not.toHaveBeenCalled();
});

test('without central configured a tick sends nothing', async () => {
    await seed(1);
    config.telemetry.central_url = undefined; config.telemetry.central_token = undefined;
    expect(await worker().tick()).toEqual({ sent: 0 });
    expect(requests).toEqual([]);
});

test('kick sends right away, but not during a backoff', async () => {
    await seed(1);
    const push = worker();
    await push.kick();
    expect(requests).toHaveLength(1);
    await seed(1);
    reply = () => ({ status: 500, body: {} });
    await push.kick();
    await seed(1);
    await push.kick();
    expect(requests).toHaveLength(2);
});

// Backoff must survive the wall clock moving: NTP or a dead CMOS battery can put it back.
test('backoff follows a monotonic clock, so a wall clock set back does not stall the push', async () => {
    await seed(1);
    reply = () => ({ status: 503, body: {} });
    const push = worker();
    let mono = 5_000_000;
    jest.spyOn(performance, 'now').mockImplementation(() => mono);
    await push.tick();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2020-01-01T00:00:00.000Z'));
    reply = (body) => ({ status: 200, body: { event_ids: body.events.map((e: { event_id: string }) => e.event_id) } });
    mono += 61_000;
    expect(await push.tick()).toEqual({ sent: 1 });
});

describe('a batch central will not take', () => {
    const quarantined = () => database.query(`SELECT event_id, quarantine_reason, payload FROM telemetry_event WHERE quarantined_at IS NOT NULL ORDER BY seq`) as Promise<Array<{ event_id: string; quarantine_reason: string }>>;

    test('413: halves the batch until central takes it', async () => {
        await seed(300);
        reply = (body) => body.events.length > 80
            ? { status: 413, body: {} }
            : { status: 200, body: { event_ids: body.events.map((e: { event_id: string }) => e.event_id) } };
        expect(await worker().tick()).toEqual({ sent: 300 });
        expect(await quarantined()).toEqual([]);
        expect(requests.filter(r => r.body.events.length <= 80).length).toBeGreaterThan(1);
    });

    test('400 caused by one row: that row is quarantined with a reason code and the rest go', async () => {
        const rows = await seed(600);
        const poison = rows[3].event_id;
        reply = (body) => body.events.some((e: { event_id: string }) => e.event_id === poison)
            ? { status: 400, body: { error: 'synthetic: bad row' } }
            : { status: 200, body: { event_ids: body.events.map((e: { event_id: string }) => e.event_id) } };
        expect(await worker().tick()).toEqual({ sent: 599 });
        expect((await quarantined()).map(r => [r.event_id, r.quarantine_reason])).toEqual([[poison, 'central_400']]);
        expect(await unsent()).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/1 event\(s\) quarantined.*central_400/));
        // Quarantined rows are not pushed again.
        requests = [];
        await worker().tick();
        expect(requests).toEqual([]);
    });

    test('rows central keeps leaving out are quarantined after 5 answers, and the push moves past them', async () => {
        const rows = await seed(600);
        const poison = new Set(rows.slice(0, 500).map(r => r.event_id));
        reply = (body) => ({ status: 200, body: { event_ids: body.events.map((e: { event_id: string }) => e.event_id).filter((id: string) => !poison.has(id)) } });
        const push = worker();
        let mono = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => mono);
        for (let i = 0; i < 5; i++) { await push.tick(); mono += 31 * 60_000; }
        expect((await quarantined()).length).toBe(500);
        expect(new Set((await quarantined()).map(r => r.quarantine_reason))).toEqual(new Set(['unconfirmed']));
        // The fifth answer quarantined them, and the same tick went on to the other 100.
        expect((await database.query(`SELECT COUNT(*) AS n FROM telemetry_event WHERE sent_at IS NOT NULL`))[0].n).toBe(100);
        expect(await repository.countUnsent()).toBe(500);
        expect(await push.tick()).toEqual({ sent: 0 });
    });

    test('a 5xx is not split: the whole batch waits for the backoff', async () => {
        await seed(10);
        reply = () => ({ status: 502, body: {} });
        await worker().tick();
        expect(requests).toHaveLength(1);
        expect(await quarantined()).toEqual([]);
    });

    test('401 says the token is wrong', async () => {
        await seed(1);
        reply = () => ({ status: 401, body: {} });
        await worker().tick();
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/HTTP 401.*central_token/));
    });
});
