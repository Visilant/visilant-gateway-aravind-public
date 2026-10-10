import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import readline from 'readline';
import type { Readable } from 'stream';
import { ZipFile } from 'yazl';
import { diagnosticId } from './index';
import type { SummaryEvent } from './summary';

export interface SegmentManifest {
    segment_id: string;
    process_instance_id: string | null;
    status: string;
    started_at: string | null;
    updated_at: string | null;
    bytes: number;
    dropped_events: number;
    node: string | null;
}

export const SEGMENT_FILES = ['manifest.json', 'events.jsonl', 'resources.jsonl'] as const;

// File access for recorder segments. Knows the on-disk layout and nothing about what
// the numbers mean. Ids are validated by the caller; this class only joins paths with
// ids that already passed diagnosticId().
export class DiagnosticsStore {
    constructor(private readonly root: string) {}

    get directory(): string {
        return this.root;
    }

    async list(): Promise<SegmentManifest[]> {
        let names: string[];
        try {
            names = await fs.readdir(this.root);
        } catch {
            return [];
        }
        const manifests: SegmentManifest[] = [];
        for (const name of names) {
            if (!diagnosticId(name)) continue;
            const manifest = await this.manifest(name);
            if (manifest) manifests.push(manifest);
        }
        const key = (m: SegmentManifest) => m.started_at ?? m.updated_at ?? '';
        return manifests.sort((a, b) => key(b).localeCompare(key(a)));
    }

    async manifest(id: string): Promise<SegmentManifest | null> {
        let data: Record<string, unknown>;
        try {
            data = JSON.parse(await fs.readFile(path.join(this.root, id, 'manifest.json'), 'utf8'));
        } catch {
            return null;
        }
        const str = (value: unknown) => (typeof value === 'string' ? value : null);
        const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        return {
            segment_id: id,
            process_instance_id: str(data.process_instance_id),
            status: str(data.status) ?? 'unknown',
            started_at: str(data.started_at),
            updated_at: str(data.updated_at),
            bytes: num(data.bytes),
            dropped_events: num(data.dropped_events),
            node: str(data.node),
        };
    }

    // Streams events.jsonl line by line. A damaged line (power loss mid-write) is
    // counted, not fatal, and the file is never loaded whole.
    async readEvents(id: string, keep: (event: SummaryEvent) => boolean = () => true): Promise<{ events: SummaryEvent[]; malformed: number }> {
        const file = path.join(this.root, id, 'events.jsonl');
        const events: SummaryEvent[] = [];
        let malformed = 0;
        try {
            await fs.access(file);
        } catch {
            return { events, malformed };
        }
        const lines = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
        for await (const line of lines) {
            if (!line.trim()) continue;
            try {
                const value = JSON.parse(line) as SummaryEvent;
                if (typeof value.name !== 'string') throw new Error('event without a name');
                if (keep(value)) events.push(value);
            } catch {
                malformed++;
            }
        }
        return { events, malformed };
    }

    // One zip with the segment's files under <id>/.
    async archive(id: string): Promise<NodeJS.ReadableStream> {
        // Complete asynchronous checks before constructing the zip. Source errors
        // must not fire while the caller is still waiting to receive the stream.
        const files: { file: string; name: string }[] = [];
        for (const name of SEGMENT_FILES) {
            const file = path.join(this.root, id, name);
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
