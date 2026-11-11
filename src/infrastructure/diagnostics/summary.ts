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

export interface DetectorSummary {
    bursts_auto: number;
    bursts_manual: number;
    suggested_kept: number;
    suggested_overridden: number;
    quality_score_p50: number | null;
    quality_score_p95: number | null;
}

export type AssessmentTask = 'cornea' | 'lens' | 'pterygium';
export const ASSESSMENT_TASKS: readonly AssessmentTask[] = ['cornea', 'lens', 'pterygium'];

export interface AssessmentSummary {
    ready: number;
    eye_not_detected: number;
    failed_or_timeout: number;
    by_task: Record<AssessmentTask, Record<string, number>>;
    confidence_p50: Record<AssessmentTask, number | null>;
    entropy_p50: Record<AssessmentTask, number | null>;
}

const CONNECTIVITY_EVENTS: ReadonlySet<string> = new Set([
    'seeker.disconnected', 'seeker.opened', 'seeker.failsafe', 'seeker.permission_denied', 'network.change', 'network.restored',
]);

export function isConnectivityEvent(event: SummaryEvent): boolean {
    return CONNECTIVITY_EVENTS.has(event.name);
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function quantileOrNull(values: number[], q: number): number | null {
    const v = quantile(values, q);
    return Number.isFinite(v) ? v : null;
}

export function detectorSummary(events: SummaryEvent[]): DetectorSummary {
    let bursts_auto = 0, bursts_manual = 0, suggested_kept = 0, suggested_overridden = 0;
    const scores: number[] = [];
    for (const event of events) {
        const a = event.attributes ?? {};
        if (event.name === 'capture.burst') {
            if (a.trigger === 'auto') bursts_auto++;
            else if (a.trigger === 'manual') bursts_manual++;
            const score = finiteOrNull(a.quality_score) ?? finiteOrNull(a.quality_score_max);
            if (score !== null) scores.push(score);
        } else if (event.name === 'capture.selected') {
            if (a.operator_overrode_suggested === true) suggested_overridden++;
            else if (a.operator_overrode_suggested === false) suggested_kept++;
        }
    }
    return {
        bursts_auto,
        bursts_manual,
        suggested_kept,
        suggested_overridden,
        quality_score_p50: quantileOrNull(scores, 0.5),
        quality_score_p95: quantileOrNull(scores, 0.95),
    };
}

export function assessmentSummary(events: SummaryEvent[]): AssessmentSummary {
    let ready = 0, eye_not_detected = 0, failed_or_timeout = 0;
    const by_task: Record<AssessmentTask, Record<string, number>> = { cornea: {}, lens: {}, pterygium: {} };
    const confidences: Record<AssessmentTask, number[]> = { cornea: [], lens: [], pterygium: [] };
    const entropies: Record<AssessmentTask, number[]> = { cornea: [], lens: [], pterygium: [] };
    for (const event of events) {
        if (event.name !== 'assessment.result') continue;
        const a = event.attributes ?? {};
        if (a.assessment_status === 'ready') {
            ready++;
            for (const task of ASSESSMENT_TASKS) {
                const label = a[`${task}_label`];
                if (typeof label === 'string' && label) by_task[task][label] = (by_task[task][label] ?? 0) + 1;
                const conf = finiteOrNull(a[`${task}_confidence`]);
                if (conf !== null) confidences[task].push(conf);
                const ent = finiteOrNull(a[`${task}_entropy`]);
                if (ent !== null) entropies[task].push(ent);
            }
        } else if (a.assessment_status === 'unavailable') {
            if (a.assessment_reason === 'eye_not_detected' || a.eye_gate_passed === false) eye_not_detected++;
            else failed_or_timeout++;
        }
    }
    return {
        ready,
        eye_not_detected,
        failed_or_timeout,
        by_task,
        confidence_p50: {
            cornea: quantileOrNull(confidences.cornea, 0.5),
            lens: quantileOrNull(confidences.lens, 0.5),
            pterygium: quantileOrNull(confidences.pterygium, 0.5),
        },
        entropy_p50: {
            cornea: quantileOrNull(entropies.cornea, 0.5),
            lens: quantileOrNull(entropies.lens, 0.5),
            pterygium: quantileOrNull(entropies.pterygium, 0.5),
        },
    };
}

