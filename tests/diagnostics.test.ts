import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DiagnosticRecorder, diagnosticContext, diagnosticId, safeAttributes } from '../src/infrastructure/diagnostics';
let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-diagnostics-test-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
async function saved() { const [segment] = await fs.readdir(directory); const root = path.join(directory, segment); return { manifest: JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')), events: (await fs.readFile(path.join(root,'events.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line)) }; }
test('uses validated correlation and excludes clinical payloads and command arguments', async () => {
  const recorder = new DiagnosticRecorder(); await recorder.start(directory);
  const run = randomUUID(), operation = randomUUID();
  diagnosticContext.run({run_id:run,operation_id:operation,request_id:'patient-secret'}, () => recorder.event('capture.queued', {bytes:123,patient_id:'patient-secret',argv:['-k','PatientName=secret'],model:'cornea'}, 12));
  await recorder.stop(); const data = await saved(); const event = data.events.find(item => item.name === 'capture.queued');
  expect(event).toMatchObject({run_id:run,operation_id:operation,request_id:null,duration_ms:12,attributes:{bytes:123,model:'cornea'}});
  expect(JSON.stringify(data)).not.toContain('patient-secret'); expect(JSON.stringify(data)).not.toContain('PatientName');
});
test('caps buffered events and reports dropped events on disk', async () => {
  const recorder = new DiagnosticRecorder(50 * 1024 * 1024, 2); await recorder.start(directory);
  for(let i=0;i<20;i++) recorder.event('test.event',{count:i});
  await recorder.stop(); const data = await saved(); expect(data.events.length).toBe(2); expect(data.manifest.dropped_events).toBeGreaterThan(0);
});
test('stops at the active segment limit without overwriting earlier events', async () => {
  const recorder = new DiagnosticRecorder(1500); await recorder.start(directory);
  for(let i=0;i<100;i++) recorder.event('test.event',{count:i});
  await recorder.stop(); const data=await saved(); expect(data.manifest.status).toBe('limit_reached'); expect(data.manifest.bytes).toBeLessThanOrEqual(1500); expect(data.events[0].name).toBe('gateway.start');
});
test('recording failure cannot throw into business operations', async () => {
  const target=path.join(directory,'file'); await fs.writeFile(target,'not a directory');
  const recorder=new DiagnosticRecorder(); await expect(recorder.start(target)).resolves.toBeUndefined();
  expect(()=>recorder.event('test.event')).not.toThrow(); await expect(recorder.stop()).resolves.toBeUndefined();
});
test('rejects unbounded identifiers and unknown or non-finite attributes', () => {
  expect(diagnosticId('../../patient')).toBeNull(); expect(safeAttributes({bytes:Infinity,unknown:42,stage:'patient name',count:1})).toEqual({count:1});
});
test('each start opens a fresh segment with its own id and start time; the process id is shared', async () => {
  const recorder = new DiagnosticRecorder();
  await recorder.start(directory); const first = recorder.segmentId; recorder.event('test.event'); await recorder.stop();
  expect(recorder.segmentId).toBeNull();
  await recorder.start(directory); const second = recorder.segmentId; recorder.event('test.event'); await recorder.stop();
  expect(first).not.toBe(second);
  const names = (await fs.readdir(directory)).sort();
  expect(names).toEqual([first, second].sort());
  const manifests = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(directory, name, 'manifest.json'), 'utf8'))));
  for (const [i, manifest] of manifests.entries()) { expect(manifest.segment_id).toBe(names[i]); expect(manifest.status).toBe('stopped'); expect(typeof manifest.started_at).toBe('string'); }
  expect(manifests[0].process_instance_id).toBe(manifests[1].process_instance_id);
});
async function manifestOf(segment: string | null) { return JSON.parse(await fs.readFile(path.join(directory, String(segment), 'manifest.json'), 'utf8')); }
async function eventsOf(segment: string | null) { return (await fs.readFile(path.join(directory, String(segment), 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
test('start while recording is a no-op and the second segment starts its byte count from zero', async () => {
  const recorder = new DiagnosticRecorder();
  await recorder.start(directory); const first = recorder.segmentId; await recorder.start(directory);
  expect(recorder.segmentId).toBe(first);
  expect(await fs.readdir(directory)).toHaveLength(1);
  for (let i = 0; i < 50; i++) recorder.event('test.event', { count: i });
  await recorder.stop();
  await recorder.start(directory); const second = recorder.segmentId; await recorder.stop();
  expect(await fs.readdir(directory)).toHaveLength(2);
  expect((await manifestOf(second)).bytes).toBeLessThan((await manifestOf(first)).bytes);
});
test('two concurrent starts open one segment and one set of intervals', async () => {
  const recorder = new DiagnosticRecorder();
  const intervals = jest.spyOn(global, 'setInterval');
  try {
    await Promise.all([recorder.start(directory), recorder.start(directory)]);
    expect(await fs.readdir(directory)).toHaveLength(1);
    expect(intervals).toHaveBeenCalledTimes(2);
  } finally { intervals.mockRestore(); await recorder.stop(); }
});
test('a flush for the old segment that completes after a new start keeps the old segment manifest', async () => {
  const recorder = new DiagnosticRecorder();
  await recorder.start(directory); const first = recorder.segmentId; recorder.event('test.event');
  const stopping = recorder.stop(); // not awaited: its flush is still queued when the next start runs
  await recorder.start(directory); const second = recorder.segmentId;
  await stopping; recorder.event('test.event'); await recorder.flush();
  const manifest = await manifestOf(first);
  expect(manifest).toMatchObject({ segment_id: first, status: 'stopped' });
  expect(await manifestOf(second)).toMatchObject({ segment_id: second, status: 'recording' });
  await recorder.stop();
  expect(await manifestOf(first)).toMatchObject({ segment_id: first, status: 'stopped' });
});
test('dropped events reset per segment while the sequence continues and every line carries its segment id', async () => {
  const recorder = new DiagnosticRecorder(50 * 1024 * 1024, 2);
  await recorder.start(directory); const first = recorder.segmentId;
  for (let i = 0; i < 20; i++) recorder.event('test.event', { count: i });
  await recorder.stop();
  await recorder.start(directory); const second = recorder.segmentId; await recorder.stop();
  expect((await manifestOf(first)).dropped_events).toBeGreaterThan(0);
  expect((await manifestOf(second)).dropped_events).toBe(0);
  const a = await eventsOf(first), b = await eventsOf(second);
  for (const line of a) expect(line.segment_id).toBe(first);
  for (const line of b) expect(line.segment_id).toBe(second);
  expect(b[0].sequence).toBeGreaterThan(a[a.length - 1].sequence);
});
test('a start that fails early leaves the previous stopped segment untouched', async () => {
  const recorder = new DiagnosticRecorder();
  await recorder.start(directory); const first = recorder.segmentId; await recorder.stop();
  const target = path.join(directory, 'file'); await fs.writeFile(target, 'not a directory');
  await recorder.start(target); await recorder.stop();
  expect(await manifestOf(first)).toMatchObject({ segment_id: first, status: 'stopped' });
});
