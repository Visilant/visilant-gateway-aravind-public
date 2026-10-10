import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DiagnosticsStore } from '../src/infrastructure/diagnostics/store';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-store-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function segment(status: string, extra: Record<string, unknown> = {}, events: string[] = []): Promise<string> {
    const id = randomUUID();
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, 'manifest.json'), JSON.stringify({ schema_version: 1, source: 'gateway', process_instance_id: 'p', status, bytes: 10, dropped_events: 0, updated_at: '2026-01-01T00:00:00.000Z', node: 'v22', ...extra }));
    if (events.length) await fs.writeFile(path.join(root, id, 'events.jsonl'), events.join('\n') + '\n');
    return id;
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}

describe('DiagnosticsStore', () => {
    it('lists recorder segments newest first, tolerating old manifests without started_at, and ignores stray files', async () => {
        const old = await segment('stopped');
        const newer = await segment('interrupted', { segment_id: 'ignored', started_at: '2026-02-01T00:00:00.000Z' });
        await fs.writeFile(path.join(root, 'notes.txt'), 'not a segment');
        await fs.mkdir(path.join(root, 'not-a-uuid'));
        const list = await new DiagnosticsStore(root).list();
        expect(list.map((m) => m.segment_id)).toEqual([newer, old]);
        expect(list[1]).toEqual({ segment_id: old, process_instance_id: 'p', status: 'stopped', started_at: null, updated_at: '2026-01-01T00:00:00.000Z', bytes: 10, dropped_events: 0, node: 'v22' });
    });

    it('returns an empty list when the root does not exist yet', async () => {
        expect(await new DiagnosticsStore(path.join(root, 'missing')).list()).toEqual([]);
    });

    it('reads events line by line, skipping and counting a damaged line, with an optional filter', async () => {
        const id = await segment('stopped', {}, [
            JSON.stringify({ name: 'capture.queued', run_id: 'r1', duration_ms: null }),
            '{"name":"capture.deliv',
            JSON.stringify({ name: 'capture.delivered', run_id: 'r2' }),
            '',
        ]);
        const store = new DiagnosticsStore(root);
        const all = await store.readEvents(id);
        expect(all.malformed).toBe(1);
        expect(all.events.map((e) => e.name)).toEqual(['capture.queued', 'capture.delivered']);
        expect((await store.readEvents(id, (e) => e.run_id === 'r1')).events).toHaveLength(1);
        expect(await store.readEvents(await segment('stopped'))).toEqual({ events: [], malformed: 0 });
    });

    it('archives the segment files under <id>/ as a zip, skipping missing files', async () => {
        const id = await segment('stopped', {}, [JSON.stringify({ name: 'gateway.start' })]);
        const zip = await drain(await new DiagnosticsStore(root).archive(id));
        expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        expect(zip.includes(Buffer.from(`${id}/manifest.json`))).toBe(true);
        expect(zip.includes(Buffer.from(`${id}/events.jsonl`))).toBe(true);
        expect(zip.includes(Buffer.from(`${id}/resources.jsonl`))).toBe(false);
    });
});

test('a file disappearing during archive preparation rejects the stream without an uncaught error', async () => {
    const id = await segment('stopped', {}, [JSON.stringify({ name: 'capture.delivered' })]);
    const access = fs.access.bind(fs);
    const spy = jest.spyOn(fs, 'access').mockImplementation(async file => {
        await access(file);
        if (String(file).endsWith('events.jsonl')) await fs.rm(file);
    });
    try { await expect(drain(await new DiagnosticsStore(root).archive(id))).rejects.toMatchObject({ code: 'ENOENT' }); }
    finally { spy.mockRestore(); }
});
