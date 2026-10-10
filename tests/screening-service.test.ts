import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';
import { CaptureRepository } from '../src/infrastructure/database/repositories';
import { ScreeningRepository } from '../src/infrastructure/database/repositories/ScreeningRepository';
import { CaptureScreeningMismatchError, EXPIRY_ACTOR, ScreeningConflictError, ScreeningNotFoundError, ScreeningService } from '../src/application/services/ScreeningService';
import { SyncWorker } from '../src/application/services/SyncWorker';
import { sourceScope } from '../src/application/services/screeningIdentity';
import { CaptureStatus } from '../src/infrastructure/database/entities';
import type { GatewayConfig } from '../src/config';
const config = { centre_code: 'SYNTHETIC', mwl: { host: 'mwl.test', port: 104, called_ae: 'W', calling_ae: 'V' }, store: {}, max_send_attempts: 1, retention: 'DELETE_ON_SENT', screening_expiry_days: 7 } as GatewayConfig;
const scope = sourceScope(config);
const order = { accession_number: 'ORDER-1', study_instance_uid: '1.2.3', step_id: 'STEP-1' };
const entry = { ...order, patient_id: 'SYNTHETIC', source_scope: scope, scheduled: { step_id: order.step_id } };
const manifest = { id: 'screening-1', source_scope: scope, order, capture_ids: ['capture-1', 'capture-2'] };
let db: DataSource, service: ScreeningService, captures: CaptureRepository, directory: string;
const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
function makeService(conf = config) { return new ScreeningService(conf, logger as never, new ScreeningRepository(db)); }
async function addCapture(clientId: string, status = CaptureStatus.PENDING, screening: string | null = manifest.id) {
 return captures.create({ id: clientId, client_capture_id: clientId, screening_id: screening, dicom_path: clientId + '.dcm', status,
 study_instance_uid: order.study_instance_uid, accession_number: order.accession_number, series_instance_uid: '1.2.3.4', sop_instance_uid: clientId,
 attempts: 0, created_at: new Date().toISOString(), created_by: null, sent_at: status === CaptureStatus.SENT ? new Date().toISOString() : null });
}
beforeEach(async () => {
 directory = mkdtempSync(path.join(tmpdir(), 'screening-test-'));
 db = new DataSource(buildDataSourceOptions(path.join(directory, 'test.db'))); await db.initialize(); await db.runMigrations();
 captures = new CaptureRepository(db); service = makeService();
});
afterEach(async () => { if (db.isInitialized) await db.destroy(); rmSync(directory, { recursive: true, force: true }); });
test('missing and partial captures stay visible; the declared last delivery removes only its order', async () => {
 expect((await service.register(manifest)).state).toBe('UPLOAD_PENDING');
 await addCapture('capture-1', CaptureStatus.SENT);
 expect((await service.status(manifest.id)).state).toBe('UPLOAD_PENDING');
 const separate = { ...entry, accession_number: 'ORDER-2' };
 const step = { ...entry, scheduled: { step_id: 'STEP-2' } };
 const absent = { ...entry, scheduled: undefined };
 expect(await service.filter([entry, separate, step, absent])).toHaveLength(4);
 await addCapture('capture-2'); expect((await service.status(manifest.id)).state).toBe('AWAITING_PACS');
 await captures.markSent('capture-2', new Date().toISOString());
 expect((await service.status(manifest.id)).state).toBe('COMPLETED');
 expect(await service.filter([entry, separate, step, absent])).toEqual(expect.arrayContaining([expect.objectContaining({ accession_number: 'ORDER-2' }), expect.objectContaining({ scheduled: { step_id: 'STEP-2' } })]));
 expect(await service.filter([entry])).toEqual([]);
 // An operator re-send of a delivered capture puts it back in the queue but cannot reopen the order.
 await captures.requeue('capture-2'); expect((await captures.findById('capture-2'))?.status).toBe('PENDING');
 expect((await service.status(manifest.id)).state).toBe('COMPLETED'); expect(await service.filter([entry])).toEqual([]);
});
test('PACS outage, manual retry and cleanup failure cannot cause early completion or restore an order', async () => {
 await service.register(manifest); await addCapture('capture-1'); await addCapture('capture-2');
 const store = { store: jest.fn().mockRejectedValue(Error('PACS offline')) };
 const storage = { exists: jest.fn().mockResolvedValue(true), absolutePath: (p: string) => p, remove: jest.fn().mockRejectedValue(Error('cleanup')) };
 const worker = new SyncWorker(config, logger as never, captures, store as never, storage as never, { prune: jest.fn().mockResolvedValue({ removed: 0 }) } as never);
 expect(await worker.tick()).toEqual({ sent: 0, failed: 2 });
 expect((await service.status(manifest.id)).state).toBe('NEEDS_ATTENTION');
 expect(await service.filter([entry])).toHaveLength(1); expect(storage.remove).not.toHaveBeenCalled();
 await captures.requeue('capture-1'); await captures.requeue('capture-2'); store.store.mockResolvedValue(undefined);
 expect(await worker.tick()).toEqual({ sent: 2, failed: 0 });
 expect(await service.filter([entry])).toHaveLength(0); expect(storage.remove).toHaveBeenCalledTimes(2);
});
test('manifest retries are immutable, membership cannot be shared, and completed orders cannot reopen', async () => {
 await service.register(manifest);
 expect((await service.register({ ...manifest, capture_ids: [...manifest.capture_ids].reverse() })).id).toBe(manifest.id);
 await expect(service.register({ ...manifest, capture_ids: ['different'] })).rejects.toBeInstanceOf(ScreeningConflictError);
 await expect(service.register({ ...manifest, id: 'other' })).rejects.toBeInstanceOf(ScreeningConflictError);
 await expect(service.register({ ...manifest, id: 'other', order: { ...order, accession_number: 'ORDER-2' } })).rejects.toBeInstanceOf(ScreeningConflictError);
 await addCapture('capture-1', CaptureStatus.SENT); await addCapture('capture-2', CaptureStatus.SENT);
 expect((await service.status(manifest.id)).state).toBe('COMPLETED');
 await expect(service.register({ ...manifest, id: 'new', capture_ids: ['new'] })).rejects.toBeInstanceOf(ScreeningConflictError);
});
test('validates capture membership, exact identity, absent step and scope before accepting retries', async () => {
 await service.register(manifest);
 await service.validateCapture(manifest.id, 'capture-1', entry);
 await service.validateCapture(manifest.id, 'capture-1', { ...entry, source_scope: 'ignored-read-only-echo' });
 for (const invalid of [{ ...entry, accession_number: 'OTHER' }, { ...entry, study_instance_uid: '1.9' }, { ...entry, scheduled: undefined }]) {
  await expect(service.validateCapture(manifest.id, 'capture-1', invalid)).rejects.toBeInstanceOf(CaptureScreeningMismatchError);
 }
 await expect(service.validateCapture(undefined, 'capture-1', entry)).rejects.toBeInstanceOf(CaptureScreeningMismatchError);
 await expect(service.validateCapture(manifest.id, 'undeclared', entry)).rejects.toBeInstanceOf(CaptureScreeningMismatchError);
});
test('restart reconciles final delivery and preserves source isolation without expiry', async () => {
 await service.register(manifest); await addCapture('capture-1', CaptureStatus.SENT); await addCapture('capture-2', CaptureStatus.SENT);
 await db.destroy(); db = new DataSource(buildDataSourceOptions(path.join(directory, 'test.db'))); await db.initialize(); await db.runMigrations();
 captures = new CaptureRepository(db); service = makeService();
 expect(await service.filter([entry])).toEqual([]);
 const changed = makeService({ ...config, centre_code: 'OTHER-SITE' });
 expect(await changed.filter([entry])).toHaveLength(1); expect(await changed.list()).toEqual([]);
 expect((await changed.status(manifest.id)).state).toBe('COMPLETED'); // a phone can still follow its own submission
 await expect(changed.status('never-registered')).rejects.toBeInstanceOf(ScreeningNotFoundError);
 const otherSource = makeService({ ...config, mwl: { ...config.mwl, called_ae: 'OTHER' } }); expect(await otherSource.filter([entry])).toHaveLength(1);
});
test('a moved worklist server (new host, port or our calling AE) keeps the same scope', async () => {
 const moved = makeService({ ...config, mwl: { host: '10.0.0.99', port: 11112, called_ae: config.mwl.called_ae, calling_ae: 'RENAMED' } });
 expect(moved.capability().source_scope).toBe(scope);
 await moved.register(manifest); await addCapture('capture-1', CaptureStatus.SENT); await addCapture('capture-2', CaptureStatus.SENT);
 expect(await service.filter([entry])).toEqual([]);
});
test('an order namespace change never strands a registered manifest: retries and uploads still succeed', async () => {
 await service.register(manifest);
 const reconfigured = makeService({ ...config, mwl: { ...config.mwl, called_ae: 'NEW-AE' } });
 expect(reconfigured.capability().source_scope).not.toBe(scope);
 expect((await reconfigured.register(manifest)).id).toBe(manifest.id);                   // retry of the old registration
 await reconfigured.validateCapture(manifest.id, 'capture-1', entry);                    // upload of a declared capture
 await expect(reconfigured.register({ ...manifest, id: 'fresh', capture_ids: ['fresh'] })).rejects.toBeInstanceOf(ScreeningConflictError);
 await expect(reconfigured.register({ ...manifest, capture_ids: ['changed'] })).rejects.toBeInstanceOf(ScreeningConflictError);
 await expect(reconfigured.validateCapture(manifest.id, 'capture-1', { ...entry, accession_number: 'OTHER' })).rejects.toBeInstanceOf(CaptureScreeningMismatchError);
});
test('migration preserves legacy pending and sent captures and never guesses membership', async () => {
 await db.undoLastMigration(); // release columns
 await db.undoLastMigration(); // screenings
 await db.query(`INSERT INTO capture(id,dicom_path,status,study_instance_uid,series_instance_uid,sop_instance_uid,accession_number,created_at,client_capture_id) VALUES ('legacy','legacy.dcm','PENDING','1.2.3','1.2.3.4','1.2.3.4.5','ORDER-1','now','old-key')`);
 await db.runMigrations();
 expect((await captures.findById('legacy'))?.screening_id).toBeNull();
 await captures.markSent('legacy', new Date().toISOString()); expect(await service.filter([entry])).toHaveLength(1);
 await expect(service.register({ ...manifest, capture_ids: ['old-key'] })).rejects.toBeInstanceOf(ScreeningConflictError);
 expect(await db.driver.createSchemaBuilder().log()).toMatchObject({ upQueries: [] });
});
test('concurrent registration leaves one immutable manifest and never discards captures', async () => {
 const results = await Promise.allSettled([service.register(manifest), service.register({ ...manifest, id: 'competitor', capture_ids: ['competitor'] })]);
 expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
 expect((await service.list())).toHaveLength(1);
});

test('a one-image order with an absent step completes exactly once and does not expire', async () => {
 const single = { ...manifest, capture_ids: ['capture-1'], order: { accession_number: order.accession_number, study_instance_uid: order.study_instance_uid } };
 const absent = { ...entry, scheduled: undefined };
 await service.register(single); expect(await service.filter([absent, entry])).toHaveLength(2);
 await service.validateCapture(single.id, 'capture-1', absent);
 await addCapture('capture-1', CaptureStatus.SENT);
 expect((await service.status(single.id)).state).toBe('COMPLETED');
 await db.query("UPDATE screening SET completed_at = '2000-01-01T00:00:00.000Z'");
 expect(await service.filter([absent, entry])).toEqual([expect.objectContaining({ scheduled: { step_id: order.step_id } })]);
});

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const screeningFor = (id: string, accession: string, ids: string[]) => ({ id, source_scope: scope, order: { ...order, accession_number: accession }, capture_ids: ids });
const row = async (id: string) => (await db.query('SELECT released_at, released_by, release_reason, last_activity_at FROM screening WHERE id = ?', [id]))[0];

test('an operator release frees the order for a new screening and keeps the record for audit', async () => {
 await service.register(manifest); await addCapture('capture-1', CaptureStatus.SENT);
 const released = await service.release(manifest.id, 'operator-1', 'PHONE_LOST');
 expect(released).toMatchObject({ state: 'RELEASED', release_reason: 'PHONE_LOST', completed_at: null, released_at: expect.any(String) });
 expect(await row(manifest.id)).toMatchObject({ released_by: 'operator-1', release_reason: 'PHONE_LOST' });
 // The order is back on the worklist with no submission attached.
 const [listed] = await service.filter([entry]); expect(listed.submission).toBeUndefined();
 // The released screening takes no more images; one already queued still reaches PACS without reopening it.
 await expect(service.validateCapture(manifest.id, 'capture-2', entry)).rejects.toBeInstanceOf(ScreeningConflictError);
 await addCapture('capture-2', CaptureStatus.SENT); expect((await service.status(manifest.id)).state).toBe('RELEASED');
 // A phone retrying the released manifest's registration is told the same thing as an upload.
 await expect(service.register(manifest)).rejects.toThrow('released at the gateway');
 // A second release changes nothing; the first operator and reason stay on the record.
 expect((await service.release(manifest.id, 'operator-2', 'OTHER')).release_reason).toBe('PHONE_LOST');
 expect((await row(manifest.id)).released_by).toBe('operator-1');
 // Phones built before release never see the new state; newer callers ask for it.
 expect(await service.list()).toEqual([]);
 expect((await service.list(true)).map(s => s.state)).toEqual(['RELEASED']);
 // A new screening for the same order registers, holds the order, and completes normally.
 const again = screeningFor('screening-2', order.accession_number, ['capture-3']);
 expect((await service.register(again)).state).toBe('UPLOAD_PENDING');
 expect((await service.filter([entry]))[0].submission).toMatchObject({ id: 'screening-2' });
 await expect(service.register(screeningFor('screening-3', order.accession_number, ['capture-4']))).rejects.toThrow('Order already submitted. Inspect screening screening-2.');
 await addCapture('capture-3', CaptureStatus.SENT, 'screening-2');
 expect(await service.filter([entry])).toEqual([]);
 expect((await service.listUnfinished()).map(s => s.id)).toEqual([manifest.id]);
 // The operator page still lists it after a worklist source change; phones do not.
 const moved = makeService({ ...config, centre_code: 'OTHER-SITE' });
 expect((await moved.listUnfinished()).map(s => s.id)).toEqual([manifest.id]); expect(await moved.list(true)).toEqual([]);
 // Released screenings drop out of every list a month after release; the row stays.
 await db.query("UPDATE screening SET released_at = ? WHERE id = ?", [daysAgo(31), manifest.id]);
 expect(await service.list(true)).toEqual([expect.objectContaining({ id: 'screening-2', state: 'COMPLETED' })]);
 expect(await service.listUnfinished()).toEqual([]); expect(await row(manifest.id)).toMatchObject({ release_reason: 'PHONE_LOST' });
});

test('a delivered screening cannot be released, and an unknown one is not found', async () => {
 await service.register(manifest); await addCapture('capture-1', CaptureStatus.SENT); await addCapture('capture-2', CaptureStatus.SENT);
 await expect(service.release(manifest.id, 'operator-1', 'RESHOOT')).rejects.toBeInstanceOf(ScreeningConflictError);
 expect((await service.status(manifest.id)).state).toBe('COMPLETED'); expect((await row(manifest.id)).released_at).toBeNull();
 await expect(service.release('never-registered', 'operator-1', 'RESHOOT')).rejects.toBeInstanceOf(ScreeningNotFoundError);
});

test('expiry releases only idle screenings that cannot finish, and never one still sending', async () => {
 await service.register(screeningFor('missing', 'A-MISSING', ['m-1']));                                   // UPLOAD_PENDING
 await service.register(screeningFor('failed', 'A-FAILED', ['f-1'])); await addCapture('f-1', CaptureStatus.FAILED, 'failed');     // NEEDS_ATTENTION
 await service.register(screeningFor('retrying', 'A-RETRY', ['r-1', 'r-2'])); await addCapture('r-1', CaptureStatus.PENDING, 'retrying'); // still in the queue
 await service.register(screeningFor('waiting', 'A-WAIT', ['w-1'])); await addCapture('w-1', CaptureStatus.SENDING, 'waiting');      // AWAITING_PACS
 await service.register(screeningFor('recent', 'A-RECENT', ['n-1']));                                     // idle, but not long enough
 await db.query('UPDATE screening SET last_activity_at = ?', [daysAgo(8)]);
 await db.query("UPDATE screening SET last_activity_at = ? WHERE id = 'recent'", [daysAgo(6)]);
 expect((await service.expire()).sort()).toEqual(['failed', 'missing']);
 expect(await row('missing')).toMatchObject({ released_by: EXPIRY_ACTOR, release_reason: 'EXPIRED' });
 expect((await service.status('retrying')).state).toBe('UPLOAD_PENDING');
 expect(await service.expire()).toEqual([]);
 // Activity restarts the clock.
 await service.touch('recent'); await db.query("UPDATE screening SET last_activity_at = ? WHERE id = 'retrying'", [daysAgo(30)]);
 expect(await service.expire(new Date(Date.now() + 2 * DAY))).toEqual([]);
 expect(await service.expire(new Date(Date.now() + 8 * DAY))).toEqual(['recent']);
});

test('expiry is off at 0 days and never touches a delivered screening', async () => {
 await service.register(screeningFor('missing', 'A-MISSING', ['m-1']));
 await service.register(screeningFor('done', 'A-DONE', ['d-1'])); await addCapture('d-1', CaptureStatus.SENT, 'done');
 await db.query('UPDATE screening SET last_activity_at = ?', [daysAgo(365)]);
 expect(await makeService({ ...config, screening_expiry_days: 0 }).expire()).toEqual([]);
 expect(await service.expire()).toEqual(['missing']);
 expect((await service.status('done')).state).toBe('COMPLETED');
});

test('the release migration keeps existing screenings live and dates their activity from registration', async () => {
 await service.register(manifest); await addCapture('capture-1', CaptureStatus.SENT);
 const before = (await db.query('SELECT created_at FROM screening'))[0].created_at;
 await db.undoLastMigration(); await db.runMigrations();
 expect((await db.query('PRAGMA foreign_key_check')).length).toBe(0);
 expect(await row(manifest.id)).toMatchObject({ released_at: null, last_activity_at: before });
 expect((await captures.findById('capture-1'))?.screening_id).toBe(manifest.id);
 await expect(service.register({ ...manifest, id: 'dup', capture_ids: ['dup'] })).rejects.toBeInstanceOf(ScreeningConflictError);
 expect(await db.driver.createSchemaBuilder().log()).toMatchObject({ upQueries: [] });
});

test('rolling the release migration back leaves no dangling capture reference', async () => {
 await service.register(manifest); await addCapture('capture-1', CaptureStatus.SENT);
 await service.release(manifest.id, 'operator-1', 'PHONE_LOST');
 await service.register(screeningFor('screening-2', order.accession_number, ['capture-3'])); await addCapture('capture-3', CaptureStatus.PENDING, 'screening-2');
 // Foreign keys stay on, as they are under `npm run migration:revert`.
 await db.undoLastMigration();
 expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
 expect((await db.query("SELECT sql FROM sqlite_master WHERE name = 'capture'"))[0].sql).toContain('REFERENCES "screening"');
 expect((await captures.findById('capture-1'))?.screening_id).toBeNull();
 expect((await captures.findById('capture-3'))?.screening_id).toBe('screening-2');
 await db.runMigrations(); expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
});
