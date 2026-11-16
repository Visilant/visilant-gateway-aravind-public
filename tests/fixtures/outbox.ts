// A TelemetryOutbox that takes everything, for tests about something else.
export function openOutbox() {
    let count = 0;
    return {
        accepts: () => true,
        inserted: (n: number) => { count += n; },
        confirmed: ({ count: n }: { count: number }) => { count -= n; },
        unsentCount: () => count,
    };
}
