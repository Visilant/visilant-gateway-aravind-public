import { mkdtempSync, rmSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Server } from 'http';
import { DataSource } from 'typeorm';
import Container from 'typedi';
import { GatewayServer } from '../src/presentation/server';
import { CONFIG, DATABASE, LOGGER } from '../src/tokens';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { AuthService } from '../src/application/services/AuthService';
import { DicomBuilder, DicomStoreClient, WorklistClient } from '../src/infrastructure/dicom';
import { SyncWorker } from '../src/application/services/SyncWorker';
import type { GatewayConfig } from '../src/config';
let server: Server, database: DataSource, directory: string, base: string;
const store = { store: jest.fn() };
const order = { accession_number: 'SYNTHETIC', study_instance_uid: '1.2.3', step_id: 'STEP' };
const source = { query: jest.fn() };
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
async function request(route: string, body?: unknown, token = 'SYNTHETIC') {
 const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
 return { status: response.status, json: await response.json() as any };
}
beforeEach(async () => {
 directory = mkdtempSync(path.join(tmpdir(), 'screening-http-')); Container.reset();
 database = new DataSource(buildDataSourceOptions(':memory:')); await database.initialize(); await database.runMigrations();
 const config = { centre_code: 'SYNTHETIC', listen_port: 0, storage_root: directory, study_uid_root: '1.2.826.0.1.3680043.10.1338',
  send_immediately: false, retention: 'DELETE_ON_SENT', max_send_attempts: 1, mwl: { host: 'synthetic', port: 104, called_ae: 'W', calling_ae: 'V' } } as GatewayConfig;
 Container.set(CONFIG, config); Container.set(DATABASE, database); Container.set(LOGGER, logger);
 Container.set(AuthService, { authenticate: async (header: string) => header === 'Bearer SYNTHETIC' ? { id: null } : null } as never);
 Container.set(DicomStoreClient, store as never);
 Container.set(DicomBuilder, { build: async (_input: string, _tags: unknown, target: string) => { await fs.writeFile(target, 'SYNTHETIC DICOM'); } } as never);
 source.query.mockResolvedValue([{ '00080050': { vr: 'SH', Value: [order.accession_number] }, '0020000D': { vr: 'UI', Value: [order.study_instance_uid] }, '00100020': { vr: 'LO', Value: ['SYNTHETIC-PATIENT'] }, '00400100': { vr: 'SQ', Value: [{ '00400009': { vr: 'SH', Value: [order.step_id] } }] } }]);
 Container.set(WorklistClient, source as never);
 store.store.mockReset(); store.store.mockResolvedValue(undefined);
 server = await Container.get(GatewayServer).start(); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await database.destroy(); Container.reset(); rmSync(directory, { recursive: true, force: true }); });
async function uploadEntry(screeningId: string | undefined, key: string, worklistEntry: unknown) {
 const form = new FormData(); form.append('file', new Blob(['synthetic JPEG'], { type: 'image/jpeg' }), 'test.jpg');
 if (screeningId) form.append('screening_id', screeningId);
 form.append('worklist_entry', JSON.stringify(worklistEntry)); form.append('laterality', 'R');
 const response = await fetch(base + '/captures', { method: 'POST', headers: { Authorization: 'Bearer SYNTHETIC', 'Idempotency-Key': key }, body: form });
 return { status: response.status, json: await response.json() as any };
}
test('authenticated and validated contracts preserve exact membership through duplicate uploads and C-STORE failures', async () => {
 for (const route of ['/screenings', '/screenings/capabilities', '/screenings/s']) expect((await request(route, undefined, '')).status).toBe(401);
 const capability = (await request('/screenings/capabilities')).json.data;
 const manifest = { id: 's', source_scope: capability.source_scope, order, capture_ids: ['one', 'two'] };
 expect((await request('/screenings', manifest, '')).status).toBe(401);
 for (const invalid of [{ ...manifest, capture_ids: [] }, { ...manifest, capture_ids: ['one','one'] }, { ...manifest, order: undefined }, { ...manifest, complete: true }, { ...manifest, source_scope: 'bad' }]) expect((await request('/screenings', invalid)).status).toBe(400);
 expect((await request('/screenings', manifest)).status).toBe(200);
 expect((await request('/screenings', manifest)).status).toBe(200);
 expect((await request('/screenings', { ...manifest, id: 'other' })).status).toBe(409);
 expect((await request('/screenings', { ...manifest, capture_ids: ['changed'] })).status).toBe(409);
 const entry = (await request('/worklist')).json.data[0];
 const upload = (key: string, changed = entry) => uploadEntry('s', key, changed);
 expect((await upload('undeclared')).status).toBe(400);
 expect((await upload('one', { ...entry, accession_number: 'WRONG' })).status).toBe(400);
 const accepted = await upload('one'); expect(accepted.status).toBe(200); expect((await upload('one')).json.data.id).toBe(accepted.json.data.id);
 await Container.get(SyncWorker).tick();
 expect((await request('/screenings/s')).json.data.state).toBe('UPLOAD_PENDING');
 expect((await request('/worklist')).json.data).toHaveLength(1);
 expect((await upload('two')).status).toBe(200); store.store.mockRejectedValueOnce(Error('synthetic PACS outage'));
 await Container.get(SyncWorker).tick(); expect((await request('/screenings/s')).json.data.state).toBe('NEEDS_ATTENTION');
 const captures = (await request('/screenings/s')).json.data.captures;
 await request(`/captures/${captures.find((c: { capture_id: string }) => c.capture_id === 'two').gateway_capture_id}/retry`, {});
 await Container.get(SyncWorker).tick();
 expect((await request('/screenings/s')).json.data.state).toBe('COMPLETED'); expect((await request('/worklist')).json.data).toEqual([]);
 expect((await request('/screenings')).json.data).toHaveLength(1);
 expect((await request('/screenings', { ...manifest, id: 'reopen', capture_ids: ['extra'] })).status).toBe(409);
});
test('a capture that echoes the worklist entry verbatim, including server-added submission status, is accepted', async () => {
 const capability = (await request('/screenings/capabilities')).json.data;
 expect((await request('/screenings', { id: 's', source_scope: capability.source_scope, order, capture_ids: ['one'] })).status).toBe(200);
 const entry = (await request('/worklist')).json.data[0];
 expect(entry.submission).toBeDefined(); expect(entry.source_scope).toBe(capability.source_scope);
 const accepted = await uploadEntry('s', 'one', entry);
 expect(accepted.status).toBe(200);
});
test('a retry of an accepted capture gets its original answer even if its order no longer validates', async () => {
 const capability = (await request('/screenings/capabilities')).json.data;
 expect((await request('/screenings', { id: 's', source_scope: capability.source_scope, order, capture_ids: ['one'] })).status).toBe(200);
 const entry = (await request('/worklist')).json.data[0];
 const accepted = await uploadEntry('s', 'one', entry); expect(accepted.status).toBe(200);
 const replay = await uploadEntry('s', 'one', { ...entry, accession_number: 'CHANGED' });
 expect(replay.status).toBe(200); expect(replay.json.data.id).toBe(accepted.json.data.id);
 const unknown = await request('/screenings/never-registered'); expect(unknown.status).toBe(404);
});
test('order identity fields are bounded at DICOM SH and source_scope must be a 64-character hash', async () => {
 const capability = (await request('/screenings/capabilities')).json.data;
 const manifest = { id: 's', source_scope: capability.source_scope, order, capture_ids: ['one'] };
 for (const invalid of [{ ...manifest, order: { ...order, accession_number: 'A'.repeat(17) } }, { ...manifest, order: { ...order, step_id: 'S'.repeat(17) } },
  { ...manifest, source_scope: capability.source_scope + 'a' }, { ...manifest, source_scope: capability.source_scope.toUpperCase() }]) {
  expect((await request('/screenings', invalid)).status).toBe(400);
 }
 expect((await request('/screenings', { ...manifest, order: { ...order, accession_number: 'A'.repeat(16) } })).status).toBe(200);
});

// Contract with the capture app. These payloads are built the way the app builds them.
const DELIVERY_STATES = ['UPLOAD_PENDING', 'AWAITING_PACS', 'NEEDS_ATTENTION', 'COMPLETED'];
function readableByApp(delivery: any): boolean {
 // Mirrors the shape check in fetchDelivery; a mismatch would fail the app's worklist refresh.
 return typeof delivery?.id === 'string' && typeof delivery.source_scope === 'string' && !!delivery.order
  && Array.isArray(delivery.captures) && DELIVERY_STATES.includes(delivery.state);
}
test('app contract: an order with no scheduled step registers with step_id null, uploads the app-shaped row, and leaves the worklist only after C-STORE', async () => {
 source.query.mockResolvedValue([{ '00080050': { vr: 'SH', Value: ['NOSTEP'] }, '0020000D': { vr: 'UI', Value: ['1.2.4'] }, '00100020': { vr: 'LO', Value: ['SYNTHETIC-PATIENT'] } }]);
 const capability = (await request('/screenings/capabilities')).json.data;
 expect(capability).toEqual({ screening_delivery: 1, screening_release: 1, source_scope: expect.stringMatching(/^[a-f0-9]{64}$/) });
 const [row] = (await request('/worklist')).json.data;
 expect(row.source_scope).toBe(capability.source_scope); expect(row.scheduled).toBeUndefined(); expect(row.submission).toBeUndefined();
 // orderIdentity(entry) in the app: step_id is null, not absent, when there is no step.
 const manifest = { id: 'app-s', source_scope: row.source_scope, order: { accession_number: row.accession_number, study_instance_uid: row.study_instance_uid, step_id: null }, capture_ids: ['app-one'] };
 const registered = await request('/screenings', manifest);
 expect(registered.status).toBe(200); expect(readableByApp(registered.json.data)).toBe(true);
 expect(registered.json.data.state).toBe('UPLOAD_PENDING');
 // uploadCapture in the app: submission stripped, source_scope kept with a screening_id.
 const { submission: _ignored, ...uploaded } = row;
 expect((await uploadEntry('app-s', 'app-one', uploaded)).status).toBe(200);
 expect((await request('/screenings/app-s')).json.data.state).toBe('AWAITING_PACS');
 expect((await request('/worklist')).json.data).toHaveLength(1);
 await Container.get(SyncWorker).tick();
 const deliveries = (await request('/screenings')).json.data;
 expect(Array.isArray(deliveries)).toBe(true); expect(deliveries.every(readableByApp)).toBe(true);
 expect(deliveries[0]).toMatchObject({ id: 'app-s', state: 'COMPLETED', order: { step_id: null } });
 expect((await request('/worklist')).json.data).toEqual([]);
});
test('app contract: an installed APK without screening support uploads the verbatim row with no screening_id; it is stored and sent but never hides the order', async () => {
 const row = (await request('/worklist')).json.data[0];
 const accepted = await uploadEntry(undefined, 'legacy-one', row);
 expect(accepted.status).toBe(200);
 expect((await uploadEntry(undefined, 'legacy-one', row)).json.data.id).toBe(accepted.json.data.id);
 await Container.get(SyncWorker).tick();
 expect(store.store).toHaveBeenCalledTimes(1);
 expect((await request('/screenings')).json.data).toEqual([]);
 expect((await request('/worklist')).json.data).toHaveLength(1);
});
test('app contract: a legacy upload cannot smuggle in a capture a manifest declared', async () => {
 const capability = (await request('/screenings/capabilities')).json.data;
 expect((await request('/screenings', { id: 's', source_scope: capability.source_scope, order, capture_ids: ['one'] })).status).toBe(200);
 const row = (await request('/worklist')).json.data[0];
 const rejected = await uploadEntry(undefined, 'one', row);
 expect(rejected.status).toBe(400); expect(JSON.stringify(rejected.json)).not.toContain('SYNTHETIC-PATIENT');
});
test('release over HTTP: signed-in only, fixed reasons, the order reopens, and the old phone is told why its upload fails', async () => {
 const capability = (await request('/screenings/capabilities')).json.data;
 const manifest = { id: 's', source_scope: capability.source_scope, order, capture_ids: ['one', 'two'] };
 expect((await request('/screenings', manifest)).status).toBe(200);
 expect((await request('/screenings/s/release', { reason: 'PHONE_LOST' }, '')).status).toBe(401);
 for (const invalid of [{}, { reason: 'EXPIRED' }, { reason: 'Patient moved away' }, { reason: 'OTHER', note: 'x' }]) {
  const rejected = await request('/screenings/s/release', invalid);
  expect(rejected.status).toBe(400); expect(JSON.stringify(rejected.json)).not.toContain('Patient moved away');
 }
 expect((await request('/screenings/missing/release', { reason: 'OTHER' })).status).toBe(404);
 const released = await request('/screenings/s/release', { reason: 'PHONE_LOST' });
 expect(released.status).toBe(200); expect(released.json.data).toMatchObject({ state: 'RELEASED', release_reason: 'PHONE_LOST' });
 // The order is back with no submission; phones that predate release never see the state.
 const [row] = (await request('/worklist')).json.data; expect(row.submission).toBeUndefined();
 expect((await request('/screenings')).json.data).toEqual([]);
 expect((await request('/screenings?view=all')).json.data).toEqual([expect.objectContaining({ id: 's', state: 'RELEASED' })]);
 expect((await request('/screenings?view=unfinished')).json.data).toHaveLength(1);
 expect((await request('/screenings?view=bogus')).status).toBe(400);
 // The phone that still holds the released screening gets a 409 that says what to do.
 const late = await uploadEntry('s', 'one', row);
 expect(late.status).toBe(409); expect(late.json.error).toMatch(/released at the gateway/);
 // A new screening for the same order is accepted.
 expect((await request('/screenings', { ...manifest, id: 's2', capture_ids: ['three'] })).status).toBe(200);
 expect((await request('/worklist')).json.data[0].submission).toMatchObject({ id: 's2' });
 expect((await request('/screenings/s2/release', { reason: 'RESHOOT' })).status).toBe(200);
});
