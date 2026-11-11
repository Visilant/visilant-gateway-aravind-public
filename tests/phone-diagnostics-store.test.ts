import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { PhoneDiagnosticsStore, type PhoneManifest } from '../src/infrastructure/diagnostics/phoneStore';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-phone-store-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const manifest = (device_id: string, last_seen_at = new Date().toISOString()) => (previous: PhoneManifest | null): PhoneManifest => ({
    schema_version: 1, device_id, manufacturer: 'Synthetic', device_model: 'Test', android_version: '14', api_level: 34, app_version: '1.0.0',
    model_revision: null, model_manifest_sha256: null, first_seen_at: previous?.first_seen_at ?? last_seen_at, last_seen_at, status: null,
    counts: { events: (previous?.counts.events ?? 0) + 1, crashes: 0, seeker_disconnects: 0, wifi_disconnects: 0, captures_taken: 0, assessments_ready: 0, assessments_unavailable: 0 },
    recent_batch_ids: previous?.recent_batch_ids ?? [],
});
const lines = async (file: string) => (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}
async function dirSize(dir: string, only: (name: string) => boolean = () => true): Promise<number> {
    let total = 0;
    for (const name of await fs.readdir(dir)) if (only(name)) total += (await fs.stat(path.join(dir, name))).size;
    return total;
}

test('appends events, resources and crashes under phones/<device_id>/ with a manifest', async () => {
    const store = new PhoneDiagnosticsStore(root), device = randomUUID();
    const result = await store.append(device, randomUUID(), { events: [{ name: 'seeker.opened' }], resources: [{ name: 'resource.sample' }], crashes: [{ crash_id: randomUUID() }] }, manifest(device));
    expect(result).toEqual({ duplicate: false });
    const dir = path.join(root, device);
    expect((await fs.readdir(dir)).sort()).toEqual(['crashes.jsonl', 'events.jsonl', 'manifest.json', 'resources.jsonl']);
    expect(JSON.parse((await lines(path.join(dir, 'events.jsonl')))[0])).toEqual({ name: 'seeker.opened' });
    expect(await store.manifest(device)).toMatchObject({ device_id: device, counts: { events: 1 } });
    expect((await store.list()).map(m => m.device_id)).toEqual([device]);
});

test('a repeated batch id is reported as a duplicate without writing lines again; only the last 64 ids are kept', async () => {
    const store = new PhoneDiagnosticsStore(root), device = randomUUID(), batch = randomUUID();
    await store.append(device, batch, { events: [{ name: 'a' }] }, manifest(device));
    expect(await store.append(device, batch, { events: [{ name: 'a' }] }, manifest(device))).toEqual({ duplicate: true });
    expect(await lines(path.join(root, device, 'events.jsonl'))).toHaveLength(1);
    expect((await store.manifest(device))!.counts.events).toBe(1);
    for (let i = 0; i < 70; i++) await store.append(device, randomUUID(), {}, manifest(device));
    const kept = (await store.manifest(device))!.recent_batch_ids;
    expect(kept).toHaveLength(64);
    expect(kept).not.toContain(batch);
});

test('concurrent appends of the same batch write it once', async () => {
    const store = new PhoneDiagnosticsStore(root), device = randomUUID(), batch = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => store.append(device, batch, { events: [{ name: 'a' }] }, manifest(device))));
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect(await lines(path.join(root, device, 'events.jsonl'))).toHaveLength(1);
});

test('rotates a stream file past the threshold, keeps at most two rotated files and stays inside the per-phone limit', async () => {
    const store = new PhoneDiagnosticsStore(root, { rotateBytes: 1000, rotatedFiles: 2, perPhoneBytes: 2500, totalBytes: 1e9 }), device = randomUUID();
    const pad = 'x'.repeat(180);
    for (let i = 0; i < 40; i++) await store.append(device, randomUUID(), { events: [{ name: 'e', i, pad }] }, manifest(device));
    const names = (await fs.readdir(path.join(root, device))).sort();
    expect(names).toContain('events.jsonl');
    expect(names).toContain('events.1.jsonl');
    expect(names).not.toContain('events.3.jsonl');
    expect(await dirSize(path.join(root, device), name => name.endsWith('.jsonl'))).toBeLessThanOrEqual(2500);
    const { records } = await store.read(device, 'events');
    // Oldest first across rotated files, ending at the newest line.
    expect(records[records.length - 1]).toMatchObject({ i: 39 });
    const order = records.map(r => r.i as number);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test('prunes the oldest inactive phone directories when the total budget is exceeded', async () => {
    const store = new PhoneDiagnosticsStore(root, { rotateBytes: 1e9, rotatedFiles: 2, perPhoneBytes: 1e9, totalBytes: 3000 });
    const pad = 'x'.repeat(900);
    const [oldest, middle, newest] = [randomUUID(), randomUUID(), randomUUID()];
    await store.append(oldest, randomUUID(), { events: [{ pad }] }, manifest(oldest, '2026-01-01T00:00:00.000Z'));
    await store.append(middle, randomUUID(), { events: [{ pad }] }, manifest(middle, '2026-01-02T00:00:00.000Z'));
    await store.append(newest, randomUUID(), { events: [{ pad }, { pad }] }, manifest(newest, '2026-01-03T00:00:00.000Z'));
    const remaining = await fs.readdir(root);
    expect(remaining).not.toContain(oldest);
    expect(remaining).toContain(newest);
    let total = 0;
    for (const name of remaining) total += await dirSize(path.join(root, name));
    expect(total).toBeLessThanOrEqual(3000);
});

test('tolerates malformed and truncated JSONL lines on read', async () => {
    const store = new PhoneDiagnosticsStore(root), device = randomUUID();
    await store.append(device, randomUUID(), { events: [{ name: 'a' }] }, manifest(device));
    await fs.appendFile(path.join(root, device, 'events.jsonl'), '{"name":"trunc\nnot json\n[1,2]\n');
    await store.append(device, randomUUID(), { events: [{ name: 'b' }] }, manifest(device));
    const read = await store.read(device, 'events');
    expect(read.records.map(r => r.name)).toEqual(['a', 'b']);
    expect(read.malformed).toBe(3);
    expect(await store.read(device, 'crashes')).toEqual({ records: [], malformed: 0 });
    expect(await store.read(randomUUID(), 'events')).toEqual({ records: [], malformed: 0 });
});

test('a damaged manifest is treated as an unknown phone, and stray entries are ignored', async () => {
    const store = new PhoneDiagnosticsStore(root), device = randomUUID();
    await fs.mkdir(path.join(root, device));
    await fs.writeFile(path.join(root, device, 'manifest.json'), '{"device_id":');
    await fs.mkdir(path.join(root, 'not-a-uuid'));
    await fs.writeFile(path.join(root, 'notes.txt'), 'x');
    expect(await store.manifest(device)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await new PhoneDiagnosticsStore(path.join(root, 'missing')).list()).toEqual([]);
});

test('streams a ZIP with the phone files under <device_id>/', async () => {
    const store = new PhoneDiagnosticsStore(root), device = randomUUID();
    await store.append(device, randomUUID(), { events: [{ name: 'a' }], resources: [{ name: 'r' }], crashes: [{ crash_id: randomUUID() }] }, manifest(device));
    const zip = await drain(await store.archive(device));
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    for (const name of ['manifest.json', 'events.jsonl', 'resources.jsonl', 'crashes.jsonl']) expect(zip.includes(Buffer.from(`${device}/${name}`))).toBe(true);
});

test('rejects a device id that is not a UUID before touching the filesystem', async () => {
    const store = new PhoneDiagnosticsStore(root);
    await expect(store.append('../../etc', randomUUID(), {}, manifest('x'))).rejects.toThrow('UUID');
    await expect(store.read('../x', 'events')).rejects.toThrow('UUID');
    await expect(store.archive('..')).rejects.toThrow('UUID');
});
