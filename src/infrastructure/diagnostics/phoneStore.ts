import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import readline from 'readline';
import type { Readable } from 'stream';
import { ZipFile } from 'yazl';
import { diagnosticId } from './index';

export type PhoneStream = 'events' | 'resources' | 'crashes';
export const PHONE_STREAMS: readonly PhoneStream[] = ['events', 'resources', 'crashes'];

export interface PhoneStatusSnapshot {
    battery_level?: number | null;
    charging?: boolean | null;
    battery_temperature_c?: number | null;
    power_save?: boolean | null;
    thermal_status?: number | null;
    network_kind?: 'wifi' | 'cellular' | 'none' | 'other' | null;
    wifi_connected?: boolean | null;
    seeker_connected?: boolean | null;
    seeker_generation?: number | null;
    pending_uploads?: number | null;
    failed_uploads?: number | null;
    free_storage_bytes?: number | null;
}

export interface PhoneCounts {
    events: number;
    crashes: number;
    seeker_disconnects: number;
    wifi_disconnects: number;
    captures_taken: number;
    assessments_ready: number;
    assessments_unavailable: number;
}

export interface PhoneManifest {
    schema_version: 1;
    device_id: string;
    manufacturer: string;
    device_model: string;
    android_version: string;
    api_level: number;
    app_version: string;
    model_revision: string | null;
    model_manifest_sha256: string | null;
    first_seen_at: string;
    last_seen_at: string;
    status: PhoneStatusSnapshot | null;
    counts: PhoneCounts;
    /** The most recent batch ids, oldest first, so a retried POST is not written twice. */
    recent_batch_ids: string[];
}

export interface PhoneStoreLimits {
    /** Stream files of one phone (current + rotated) are kept under this many bytes. */
    perPhoneBytes: number;
    /** A stream file is rotated to <stream>.1.jsonl before it would grow past this. */
    rotateBytes: number;
    /** Rotated files kept per stream. */
    rotatedFiles: number;
    /** All phone directories together; the oldest inactive phones are removed first. */
    totalBytes: number;
}

const MiB = 1024 * 1024;
export const DEFAULT_PHONE_LIMITS: PhoneStoreLimits = { perPhoneBytes: 25 * MiB, rotateBytes: 10 * MiB, rotatedFiles: 2, totalBytes: 150 * MiB };
export const RECENT_BATCH_IDS = 64;

export class InvalidPhoneIdError extends Error { constructor() { super('device id must be a UUID'); } }

// Durable per-phone storage for telemetry pushed by capture phones. Knows the on-disk
// layout and the disk budget, nothing about what the records mean:
//
//   <root>/<device_id>/manifest.json
//   <root>/<device_id>/{events,resources,crashes}.jsonl   (+ .1.jsonl, .2.jsonl rotated)
//
// The gateway runs unattended, so every write is bounded: streams rotate, each phone
// has a byte limit, and the whole tree has a budget that evicts the phones not seen
// for longest. Writes are serialised so the dedupe check and the append are atomic
// with respect to each other.
export class PhoneDiagnosticsStore {
    private static tails = new Map<string, Promise<unknown>>();
    private readonly limits: PhoneStoreLimits;

    constructor(private readonly root: string, limits: Partial<PhoneStoreLimits> = {}) {
        this.limits = { ...DEFAULT_PHONE_LIMITS, ...limits };
    }

    get directory(): string { return this.root; }

    private dir(deviceId: string): string {
        const id = diagnosticId(deviceId);
        if (!id) throw new InvalidPhoneIdError();
        return path.join(this.root, id);
    }

    private file(dir: string, stream: PhoneStream, index = 0): string {
        return path.join(dir, index ? `${stream}.${index}.jsonl` : `${stream}.jsonl`);
    }

    // One queue per root, shared by every store instance (the service builds a store per call).
    private serialise<T>(work: () => Promise<T>): Promise<T> {
        const key = path.resolve(this.root);
        const result = (PhoneDiagnosticsStore.tails.get(key) ?? Promise.resolve()).then(work);
        const tail = result.catch(() => undefined);
        PhoneDiagnosticsStore.tails.set(key, tail);
        void tail.then(() => { if (PhoneDiagnosticsStore.tails.get(key) === tail) PhoneDiagnosticsStore.tails.delete(key); });
        return result;
    }

    /**
     * Append one batch. Returns duplicate: true, writing nothing, when the batch id is
     * among the phone's recent ones. `update` builds the next manifest from the previous.
     */
    async append(deviceId: string, batchId: string, records: Partial<Record<PhoneStream, readonly object[]>>,
        update: (previous: PhoneManifest | null) => PhoneManifest): Promise<{ duplicate: boolean }> {
        const dir = this.dir(deviceId);
        const id = path.basename(dir);
        return this.serialise(async () => {
            const previous = await this.manifest(id);
            if (previous?.recent_batch_ids.includes(batchId)) return { duplicate: true };
            await fs.mkdir(dir, { recursive: true });
            for (const stream of PHONE_STREAMS) {
                const items = records[stream] ?? [];
                if (!items.length) continue;
                const text = items.map(item => JSON.stringify(item) + '\n').join('');
                await this.rotateIfNeeded(dir, stream, Buffer.byteLength(text));
                await fs.appendFile(this.file(dir, stream), text);
            }
            const next = update(previous);
            next.device_id = id;
            next.recent_batch_ids = [...(previous?.recent_batch_ids ?? []), batchId].slice(-RECENT_BATCH_IDS);
            // Write-then-rename so a power cut never leaves a half-written manifest.
            const temp = path.join(dir, 'manifest.json.tmp');
            await fs.writeFile(temp, JSON.stringify(next, null, 2));
            await fs.rename(temp, path.join(dir, 'manifest.json'));
            await this.enforcePhoneLimit(dir);
            await this.enforceBudget(id);
            return { duplicate: false };
        });
    }

    private async size(file: string): Promise<number> {
        try { return (await fs.stat(file)).size; } catch { return 0; }
    }

    private async rotateIfNeeded(dir: string, stream: PhoneStream, incoming: number): Promise<void> {
        const current = await this.size(this.file(dir, stream));
        if (current === 0 || current + incoming <= this.limits.rotateBytes) return;
        const keep = this.limits.rotatedFiles;
        await fs.rm(this.file(dir, stream, keep || 1), { force: true });
        if (keep === 0) { await fs.rm(this.file(dir, stream), { force: true }); return; }
        for (let index = keep - 1; index >= 1; index--) {
            try { await fs.rename(this.file(dir, stream, index), this.file(dir, stream, index + 1)); } catch { /* gap after eviction */ }
        }
        await fs.rename(this.file(dir, stream), this.file(dir, stream, 1));
    }

    private async streamFiles(dir: string): Promise<{ file: string; size: number; rotated: number; mtime: number }[]> {
        let names: string[];
        try { names = await fs.readdir(dir); } catch { return []; }
        const files = [];
        for (const name of names) {
            const match = /^(events|resources|crashes)(?:\.(\d+))?\.jsonl$/.exec(name);
            if (!match) continue;
            try {
                const stat = await fs.stat(path.join(dir, name));
                files.push({ file: path.join(dir, name), size: stat.size, rotated: Number(match[2] ?? 0), mtime: stat.mtimeMs });
            } catch { /* removed meanwhile */ }
        }
        return files;
    }

    // Oldest rotated files go first; if the current files alone are still over, the
    // largest one is dropped. Telemetry is best-effort; disk space is not.
    private async enforcePhoneLimit(dir: string): Promise<void> {
        const files = await this.streamFiles(dir);
        let total = files.reduce((sum, item) => sum + item.size, 0);
        const order = [...files].sort((a, b) => (b.rotated - a.rotated) || (a.mtime - b.mtime) || (b.size - a.size));
        const current = order.filter(item => item.rotated === 0).sort((a, b) => b.size - a.size);
        for (const item of [...order.filter(item => item.rotated > 0), ...current]) {
            if (total <= this.limits.perPhoneBytes) break;
            await fs.rm(item.file, { force: true });
            total -= item.size;
        }
    }

    private async dirSize(dir: string): Promise<number> {
        let total = 0;
        try { for (const name of await fs.readdir(dir)) total += await this.size(path.join(dir, name)); } catch { /* gone */ }
        return total;
    }

    private async enforceBudget(active: string): Promise<void> {
        const phones: { id: string; size: number; seen: string }[] = [];
        for (const id of await this.ids()) {
            const manifest = await this.manifest(id);
            let seen = manifest?.last_seen_at ?? '';
            if (!seen) { try { seen = (await fs.stat(path.join(this.root, id))).mtime.toISOString(); } catch { continue; } }
            phones.push({ id, size: await this.dirSize(path.join(this.root, id)), seen });
        }
        let total = phones.reduce((sum, item) => sum + item.size, 0);
        for (const phone of phones.filter(item => item.id !== active).sort((a, b) => a.seen.localeCompare(b.seen))) {
            if (total <= this.limits.totalBytes) break;
            await fs.rm(path.join(this.root, phone.id), { recursive: true, force: true });
            total -= phone.size;
        }
    }

    private async ids(): Promise<string[]> {
        let names: string[];
        try { names = await fs.readdir(this.root); } catch { return []; }
        const ids: string[] = [];
        for (const name of names) {
            if (diagnosticId(name) !== name) continue;
            try { if ((await fs.stat(path.join(this.root, name))).isDirectory()) ids.push(name); } catch { /* removed meanwhile */ }
        }
        return ids;
    }

    async manifest(deviceId: string): Promise<PhoneManifest | null> {
        const dir = this.dir(deviceId);
        try {
            const data = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as PhoneManifest;
            if (!data || typeof data !== 'object' || typeof data.last_seen_at !== 'string' || !data.counts) return null;
            return { ...data, device_id: path.basename(dir), recent_batch_ids: Array.isArray(data.recent_batch_ids) ? data.recent_batch_ids : [] };
        } catch {
            return null;
        }
    }

    /** Manifests of every phone that has reported, most recently seen first. */
    async list(): Promise<PhoneManifest[]> {
        const manifests: PhoneManifest[] = [];
        for (const id of await this.ids()) {
            const manifest = await this.manifest(id);
            if (manifest) manifests.push(manifest);
        }
        return manifests.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
    }

    /**
     * Every record of a stream, oldest first across rotated files. Damaged lines (a power
     * cut mid-append) are counted, not fatal, and files are streamed rather than loaded whole.
     */
    async read(deviceId: string, stream: PhoneStream, keep: (record: Record<string, unknown>) => boolean = () => true): Promise<{ records: Record<string, unknown>[]; malformed: number }> {
        const dir = this.dir(deviceId);
        const records: Record<string, unknown>[] = [];
        let malformed = 0;
        for (let index = this.limits.rotatedFiles; index >= 0; index--) {
            const file = this.file(dir, stream, index);
            try { await fs.access(file); } catch { continue; }
            const lines = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
            for await (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const value = JSON.parse(line);
                    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a record');
                    if (keep(value)) records.push(value);
                } catch {
                    malformed++;
                }
            }
        }
        return { records, malformed };
    }

    /** One zip with the phone's manifest and stream files under <device_id>/. */
    async archive(deviceId: string): Promise<NodeJS.ReadableStream> {
        const dir = this.dir(deviceId);
        const id = path.basename(dir);
        const names = ['manifest.json'];
        for (const stream of PHONE_STREAMS) {
            for (let index = this.limits.rotatedFiles; index >= 1; index--) names.push(`${stream}.${index}.jsonl`);
            names.push(`${stream}.jsonl`);
        }
        // Finish the asynchronous checks before building the zip, so a source error
        // cannot fire while the caller is still waiting for the stream.
        const files: { file: string; name: string }[] = [];
        for (const name of names) {
            const file = path.join(dir, name);
            try { await fs.access(file); } catch { continue; }
            files.push({ file, name });
        }
        const zip = new ZipFile();
        zip.on('error', err => (zip.outputStream as Readable).destroy(err));
        for (const { file, name } of files) zip.addFile(file, `${id}/${name}`);
        zip.end();
        return zip.outputStream;
    }
}
