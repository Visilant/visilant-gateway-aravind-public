import { eventCounts, operationKey, pendingDeliveries, quantile, runsSeen, spanRows, type SummaryEvent } from '../src/infrastructure/diagnostics/summary';

const ev = (name: string, extra: Record<string, unknown> = {}): SummaryEvent => ({ source: 'gateway', name, outcome: 'ok', attributes: {}, ...extra });

describe('quantile', () => {
    it('is nearest-rank, as the collector has always reported it', () => {
        expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
        expect(quantile([5, 1, 3, 2, 4], 0.95)).toBe(5);
        expect(quantile([7], 0.99)).toBe(7);
    });

    it('has no value for an empty input', () => {
        expect(quantile([], 0.5)).toBeNaN();
    });
});

describe('operationKey and spanRows', () => {
    it('groups by source, name, model, stage and outcome, and flags small samples', () => {
        const events = [
            ev('classifier.inference', { duration_ms: 10, attributes: { model: 'cornea' } }),
            ev('classifier.inference', { duration_ms: 30, attributes: { model: 'cornea' } }),
            ev('classifier.inference', { duration_ms: 50, attributes: { model: 'lens', stage: 'warm' }, outcome: 'error' }),
            ev('capture.delivered'),                                    // no duration: not a span
            ev('subprocess.storescu', { duration_ms: Number.NaN }),     // not finite: ignored
        ];
        expect(operationKey(events[2])).toBe('gateway.classifier.inference.lens.warm.error');
        expect(spanRows(events)).toEqual([
            { name: 'gateway.classifier.inference.cornea.ok', count: 2, p50_ms: 10, p95_ms: 30, p99_ms: 30, max_ms: 30, small_sample: true },
            { name: 'gateway.classifier.inference.lens.warm.error', count: 1, p50_ms: 50, p95_ms: 50, p99_ms: 50, max_ms: 50, small_sample: true },
        ]);
        const many = Array.from({ length: 100 }, (_, i) => ev('x', { duration_ms: i }));
        expect(spanRows(many)[0].small_sample).toBe(false);
    });

    it('handles a long recording without overflowing the call stack', () => {
        const n = 250_000;
        const events = Array.from({ length: n }, (_, i) => ev('detector.frame', { duration_ms: (i * 7919) % n }));
        const [row] = spanRows(events);
        expect(row).toEqual({ name: 'gateway.detector.frame.ok', count: n, p50_ms: n / 2 - 1, p95_ms: n * 0.95 - 1, p99_ms: n * 0.99 - 1, max_ms: n - 1, small_sample: false });
    });
});

describe('eventCounts, pendingDeliveries, runsSeen', () => {
    it('counts every event name and reports queued operations without a delivery', () => {
        const events = [
            ev('capture.queued', { run_id: 'r1', operation_id: 'op1' }),
            ev('capture.queued', { run_id: 'r1', operation_id: 'op2' }),
            ev('capture.delivered', { run_id: 'r2', operation_id: 'op1' }),
            ev('queue.tick', { run_id: null }),
        ];
        expect(eventCounts(events)).toEqual([{ name: 'capture.delivered', count: 1 }, { name: 'capture.queued', count: 2 }, { name: 'queue.tick', count: 1 }]);
        expect(pendingDeliveries(events)).toEqual({ acknowledged: ['op1'], pending: ['op2'] });
        expect(pendingDeliveries(events.filter((e) => e.run_id === 'r1'))).toEqual({ acknowledged: [], pending: ['op1', 'op2'] });
        expect(runsSeen(events)).toEqual(['r1', 'r2']);
    });
});
