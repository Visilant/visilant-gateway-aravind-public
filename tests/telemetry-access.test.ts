import { HttpError } from 'routing-controllers';
import { TelemetryAccess } from '../src/presentation/middlewares/telemetry-access.middleware';

// The route takes a few types without sign-in, so anyone on the centre's LAN can reach
// it. This middleware is where that is bounded: per client, for the whole gateway, and
// by size.

let enabled: boolean;
const auth = { authenticate: jest.fn(async (header?: string) => header === 'Bearer OK' ? { id: 'u1' } : null) };
let mono = 0;

function access() {
    return new TelemetryAccess({ get enabled() { return enabled; } } as never, auth as never);
}
async function call(middleware: TelemetryAccess, { ip = '10.0.0.5', token, body = { events: [] } }: { ip?: string; token?: string; body?: unknown } = {}) {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, socket: { remoteAddress: ip }, body } as any;
    const headers: Record<string, string> = {};
    let ended: number | null = null;
    const res = { setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; }, status: (code: number) => ({ end: () => { ended = code; } }) } as any;
    let error: unknown = 'not called';
    await middleware.use(req, res, (err?: unknown) => { error = err; });
    return { req, headers, ended, error: error as HttpError | undefined | 'not called' };
}

beforeEach(() => {
    enabled = true;
    mono = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => mono);
});
afterEach(() => jest.restoreAllMocks());

test('telemetry off: answers 204 before anything else, and counts nothing', async () => {
    enabled = false;
    const middleware = access();
    for (let i = 0; i < 40; i++) expect((await call(middleware)).ended).toBe(204);
    expect(auth.authenticate).not.toHaveBeenCalled();
});

test('a valid token passes with the user set, and is never rate-limited', async () => {
    const middleware = access();
    for (let i = 0; i < 200; i++) {
        const result = await call(middleware, { token: 'OK' });
        expect(result.error).toBeUndefined();
        expect(result.req.user).toEqual({ id: 'u1' });
    }
});

test('without a token: 30 a minute per client IP, then 429 with Retry-After', async () => {
    const middleware = access();
    for (let i = 0; i < 30; i++) expect((await call(middleware)).error).toBeUndefined();
    const limited = await call(middleware);
    expect((limited.error as HttpError).httpCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await call(middleware, { ip: '10.0.0.6' })).error).toBeUndefined();
    mono += 60_000;
    expect((await call(middleware)).error).toBeUndefined();
});

// Rotating addresses (IPv6 privacy addresses, for one) get around a per-IP limit.
test('without a token: 120 a minute for the whole gateway, whatever the addresses', async () => {
    const middleware = access();
    for (let i = 0; i < 120; i++) expect((await call(middleware, { ip: `fd00::${i}` })).error).toBeUndefined();
    const limited = await call(middleware, { ip: 'fd00::ffff' });
    expect((limited.error as HttpError).httpCode).toBe(429);
    expect((limited.error as HttpError).message).toMatch(/all phones/);
    expect((await call(middleware, { token: 'OK' })).error).toBeUndefined();
});

test('an invalid token is treated as none', async () => {
    const result = await call(access(), { token: 'EXPIRED' });
    expect(result.error).toBeUndefined();
    expect(result.req.user).toBeUndefined();
});

test('without a token a request may be at most 32 KB', async () => {
    const big = { events: [{ pad: 'x'.repeat(33 * 1024) }] };
    const result = await call(access(), { body: big });
    expect((result.error as HttpError).httpCode).toBe(413);
    expect((result.error as HttpError).message).toMatch(/32 KB.*sign in/);
    expect((await call(access(), { body: big, token: 'OK' })).error).toBeUndefined();
});
