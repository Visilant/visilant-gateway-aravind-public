import { FixedWindowLimiter } from '../src/presentation/rate-limiter';

test('allows the limit per key per window, then reports when to retry', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowLimiter(3, 60_000, () => now);
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.take('b').allowed).toBe(true);
    now += 45_000;
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 15 });
    now += 15_000;
    expect(limiter.take('a').allowed).toBe(true);
});

test('forgets expired keys, so many one-off clients do not grow memory forever', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1_000, () => now);
    for (let i = 0; i < 5_000; i++) limiter.take(`client-${i}`);
    now += 1_000;
    limiter.take('late');
    expect(limiter.size).toBe(1);
});
