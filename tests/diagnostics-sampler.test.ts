import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createResourceSampler, storageSample } from '../src/infrastructure/diagnostics/sampler';

describe('createResourceSampler', () => {
    it('returns finite process figures and can be disposed', () => {
        const sampler = createResourceSampler();
        const sample = sampler.sample();
        for (const key of ['cpu_percent', 'rss_bytes', 'heap_used_bytes', 'heap_total_bytes', 'external_bytes', 'event_loop_p95_ms'] as const) {
            expect(Number.isFinite(sample[key])).toBe(true);
        }
        expect(sample.rss_bytes).toBeGreaterThan(0);
        expect(() => sampler.dispose()).not.toThrow();
    });
});

describe('storageSample', () => {
    it('reports free bytes and the database size, or null when a path is missing', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-sampler-'));
        const db = path.join(dir, 'gateway.db');
        writeFileSync(db, 'x'.repeat(10));
        expect(await storageSample(dir, db)).toEqual({ free_bytes: expect.any(Number), database_bytes: 10 });
        expect(await storageSample(path.join(dir, 'missing'), path.join(dir, 'missing.db'))).toEqual({ free_bytes: null, database_bytes: null });
    });
});
