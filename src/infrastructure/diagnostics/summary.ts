// Pure roll-up over recorder events. Kept free of I/O and of imports from the rest of
// src/ so that external tools can load it from the compiled build.

export interface SummaryEvent {
    source?: string;
    name: string;
    outcome?: string;
    duration_ms?: number | null;
    run_id?: string | null;
    operation_id?: string | null;
    attributes?: Record<string, unknown>;
}

export interface SpanRow {
    name: string;
    count: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    max_ms: number;
    small_sample: boolean;
}

// Nearest-rank: the value at ceil(n·q), as the collector has always reported it.
// An empty input has no quantile and yields NaN.
export function quantile(values: number[], q: number): number {
    return nearestRank([...values].sort((a, b) => a - b), q);
}

function nearestRank(sorted: number[], q: number): number {
    if (sorted.length === 0) return Number.NaN;
    return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
}

export function operationKey(event: SummaryEvent): string {
    const a = event.attributes ?? {};
    const model = typeof a.model === 'string' ? `.${a.model}` : '';
    const stage = typeof a.stage === 'string' ? `.${a.stage}` : '';
    return `${event.source ?? 'gateway'}.${event.name}${model}${stage}.${event.outcome ?? 'ok'}`;
}

export function spanRows(events: SummaryEvent[], key: (event: SummaryEvent) => string = operationKey): SpanRow[] {
    const groups = new Map<string, number[]>();
    for (const event of events) {
        if (typeof event.duration_ms !== 'number' || !Number.isFinite(event.duration_ms)) continue;
        const k = key(event);
        const values = groups.get(k);
        if (values) values.push(event.duration_ms);
        else groups.set(k, [event.duration_ms]);
    }
    return [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, values]) => {
            // Sort once per group. No Math.max(...values): spreading a long recording's
            // per-frame durations overflows the call stack.
            const sorted = values.sort((a, b) => a - b);
            return {
                name,
                count: sorted.length,
                p50_ms: nearestRank(sorted, 0.5),
                p95_ms: nearestRank(sorted, 0.95),
                p99_ms: nearestRank(sorted, 0.99),
                max_ms: sorted[sorted.length - 1],
                small_sample: sorted.length < 100,
            };
        });
}

export function eventCounts(events: SummaryEvent[]): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }));
}

// Operation ids the gateway queued, split by whether the archive acknowledged them.
export function pendingDeliveries(events: SummaryEvent[]): { acknowledged: string[]; pending: string[] } {
    const queued = new Set<string>();
    const delivered = new Set<string>();
    for (const event of events) {
        if (!event.operation_id) continue;
        if (event.name === 'capture.queued') queued.add(event.operation_id);
        if (event.name === 'capture.delivered') delivered.add(event.operation_id);
    }
    return {
        acknowledged: [...queued].filter((id) => delivered.has(id)),
        pending: [...queued].filter((id) => !delivered.has(id)),
    };
}

export function runsSeen(events: SummaryEvent[]): string[] {
    const ids = new Set<string>();
    for (const event of events) if (typeof event.run_id === 'string' && event.run_id) ids.add(event.run_id);
    return [...ids];
}
