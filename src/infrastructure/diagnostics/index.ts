import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { createResourceSampler, type ProcessSample } from './sampler';

export interface Correlation { started_ms?: number; span_id?: string; parent_span_id?: string | null; run_id?: string | null; operation_id?: string | null; request_id?: string | null }
const ids = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function diagnosticId(value: unknown): string | null { return typeof value === 'string' && ids.test(value) ? value.toLowerCase() : null; }
export const diagnosticContext = new AsyncLocalStorage<Correlation>();
const allowed = new Set(['bytes','count','attempt','status','stage','model','threads','baseline','due','deferred','pending','sending','sent','failed','oldest_age_ms','queue_wait_ms','elapsed_ms','width','height','duplicates','batch_size','cpu_percent','rss_bytes','heap_used_bytes','heap_total_bytes','external_bytes','event_loop_p95_ms','free_bytes','database_bytes','row_count','error_code','route','method','dropped_events','process_cpu_unavailable','child_resources_unavailable']);
export function safeAttributes(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(input)) {
        if (!allowed.has(key)) continue;
        if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
        else if (typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,64}$/.test(value)) out[key] = value;
    }
    return out;
}

export class DiagnosticRecorder {
    private queue: { stream: string; line: string }[] = [];
    private sequence = 0;
    private dropped = 0;
    private bytes = 0;
    private active = false;
    private directory = '';
    private segment = '';
    private startedAt = '';
    private timer?: NodeJS.Timeout;
    private resources?: NodeJS.Timeout;
    private sampler?: { sample(): ProcessSample; dispose(): void };
    private writeTail: Promise<void> = Promise.resolve();
    private starting?: Promise<void>;
    private status = 'stopped';
    private readonly instance = randomUUID();
    constructor(private readonly limit = 50 * 1024 * 1024, private readonly capacity = 2048) {}
    get enabled(): boolean { return this.active; }
    get segmentId(): string | null { return this.active ? this.segment : null; }
    // Each start opens a new segment directory; the operator page can stop and start
    // recording without restarting the process. The process id is shared across segments.
    // Overlapping calls (a double-click on the operator page) share the in-flight start.
    start(root: string): Promise<void> {
        if (this.active) return Promise.resolve();
        if (!this.starting) this.starting = this.open(root).finally(() => { this.starting = undefined; });
        return this.starting;
    }
    private async open(root: string): Promise<void> {
        // Forget the previous segment first, so a start that fails early cannot rewrite its manifest.
        this.directory = ''; this.segment = ''; this.startedAt = '';
        // Let writes queued for the previous segment land before this one is created.
        await this.writeTail;
        try {
            await fs.mkdir(root, { recursive: true });
            // Recover segments from processes interrupted without a final flush/stop.
            for (const name of await fs.readdir(root)) {
                const manifest = path.join(root, name, 'manifest.json');
                try {
                    const data = JSON.parse(await fs.readFile(manifest, 'utf8'));
                    if (data.status === 'recording') await fs.writeFile(manifest, JSON.stringify({ ...data, status: 'interrupted' }));
                } catch { /* Non-recorder files are ignored. */ }
            }
            const segments: { dir: string; size: number; time: number }[] = [];
            for (const name of await fs.readdir(root)) {
                if (!diagnosticId(name)) continue;
                const dir = path.join(root, name);
                const stat = await fs.stat(dir);
                if (!stat.isDirectory()) continue;
                let size = 0;
                for (const file of await fs.readdir(dir)) size += (await fs.stat(path.join(dir, file))).size;
                segments.push({ dir, size, time: stat.mtimeMs });
            }
            let total = segments.reduce((sum, item) => sum + item.size, 0);
            for (const item of segments.sort((a, b) => a.time - b.time)) {
                if (total <= 150 * 1024 * 1024) break;
                await fs.rm(item.dir, { recursive: true, force: true }); total -= item.size;
            }
            this.segment = randomUUID(); this.startedAt = new Date().toISOString();
            this.bytes = 0; this.dropped = 0; this.queue = [];
            this.directory = path.join(root, this.segment);
            await fs.mkdir(this.directory);
            this.active = true; this.status = 'recording';
            await this.manifest(this.snapshot());
            this.timer = setInterval(() => { void this.flush(); }, 1000); this.timer.unref();
            const sampler = createResourceSampler(); this.sampler = sampler;
            this.resources = setInterval(() => {
                this.event('runtime.sample', { ...sampler.sample(), child_resources_unavailable: true }, undefined, 'ok', 'resources');
                if (this.resourceProbe) void this.resourceProbe().then(attributes => this.event('runtime.storage', attributes, undefined, 'ok', 'resources')).catch(() => {});
            }, 2000); this.resources.unref();
            this.event('gateway.start', { threads: 1, stage: process.version });
        } catch { this.fail('write_error'); }
    }
    private resourceProbe?: () => Promise<Record<string, unknown>>;
    setResourceProbe(probe: () => Promise<Record<string, unknown>>) { this.resourceProbe = probe; }
    event(name: string, attributes: Record<string, unknown> = {}, duration?: number, outcome = 'ok', stream = 'events'): void {
        if (!this.active) return;
        try {
            if (this.queue.length >= this.capacity) { this.dropped++; return; }
            const correlation = diagnosticContext.getStore();
            const line = JSON.stringify({ schema_version: 1, source: 'gateway', process_instance_id: this.instance, segment_id: this.segment, sequence: ++this.sequence,
                span_id: diagnosticId(correlation?.span_id), parent_span_id: diagnosticId(correlation?.parent_span_id),
                run_id: diagnosticId(correlation?.run_id), operation_id: diagnosticId(correlation?.operation_id), request_id: diagnosticId(correlation?.request_id),
                utc: new Date().toISOString(), monotonic_ms: performance.now(), name, duration_ms: duration ?? null, outcome,
                attributes: safeAttributes(attributes) }) + '\n';
            if (this.bytes + Buffer.byteLength(line) > this.limit) { this.fail('limit_reached'); return; }
            this.bytes += Buffer.byteLength(line); this.queue.push({ stream, line });
        } catch { this.dropped++; }
    }
    // The batch, directory and manifest fields are captured at call time: a write that lands
    // after the next start still describes its own segment, and its failure cannot stop the new one.
    flush(): Promise<void> {
        const batch = this.queue.splice(0);
        const snapshot = this.snapshot();
        this.writeTail = this.writeTail.then(async () => {
            try {
                for (const stream of ['events','resources']) {
                    const text = batch.filter(item => item.stream === stream).map(item => item.line).join('');
                    if (text) await fs.appendFile(path.join(snapshot.directory, stream + '.jsonl'), text);
                }
                if (snapshot.directory) await this.manifest(snapshot);
            } catch { if (this.segment === snapshot.segment) this.fail('write_error'); }
        });
        return this.writeTail;
    }
    private snapshot() { return { directory: this.directory, segment: this.segment, startedAt: this.startedAt, status: this.status, bytes: this.bytes, dropped: this.dropped }; }
    private async manifest(snapshot: ReturnType<DiagnosticRecorder['snapshot']>) {
        await fs.writeFile(path.join(snapshot.directory, 'manifest.json'), JSON.stringify({ schema_version: 1, source: 'gateway', process_instance_id: this.instance,
            segment_id: snapshot.segment, started_at: snapshot.startedAt,
            status: snapshot.status, bytes: snapshot.bytes, dropped_events: snapshot.dropped, updated_at: new Date().toISOString(), node: process.version,
            capabilities: { child_resources: 'unavailable_use_host_trace' } }, null, 2));
    }
    private fail(status: string) { this.active = false; this.status = status; clearInterval(this.timer); clearInterval(this.resources); this.sampler?.dispose(); this.sampler = undefined; }
    async stop(): Promise<void> { if (this.starting) await this.starting; this.event('gateway.stop'); if (this.active) this.fail('stopped'); await this.flush(); }
}
export const diagnostics = new DiagnosticRecorder();
export async function diagnosticSpan<T>(name: string, action: () => Promise<T>, attributes: Record<string, unknown> = {}): Promise<T> {
    if (!diagnostics.enabled) return action();
    const start = performance.now();
    const parent = diagnosticContext.getStore();
    const context = { ...parent, span_id: randomUUID(), parent_span_id: parent?.span_id ?? null };
    return diagnosticContext.run(context, async () => {
        try { const result = await action(); diagnostics.event(name, attributes, performance.now() - start, result === false ? 'error' : 'ok'); return result; }
        catch (error) { diagnostics.event(name, { ...attributes, error_code: 'operation_failed' }, performance.now() - start, 'error'); throw error; }
    });
}
export function profile(name: string): MethodDecorator {
    return (_target, _key, descriptor: PropertyDescriptor) => {
        const original = descriptor.value;
        descriptor.value = function (...args: unknown[]) { return diagnosticSpan(name, () => original.apply(this, args)); };
    };
}
