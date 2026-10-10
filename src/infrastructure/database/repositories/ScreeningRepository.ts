import { Inject, Service } from 'typedi';
import { DataSource, In, IsNull, LessThan, MoreThan } from 'typeorm';
import { DATABASE } from '../../../tokens';
import { ReleaseReason, ScreeningEntity } from '../entities';

// What a manifest needs to know about one of its captures.
export interface ScreeningCaptureRow {
    screening_id: string;
    client_capture_id: string;
    status: string;
    sent_at: string | null;
    id: string;
}

// SQLite allows far more bound variables than this, but a chunk keeps any one
// statement small on a box that has accumulated years of manifests.
const CHUNK = 500;

// Neither completed nor released: the screening still holds its order.
const LIVE = { completed_at: IsNull(), released_at: IsNull() } as const;

// Data access for screening manifests. The completion rule and the membership rules live
// in ScreeningService; this class only reads and writes rows.
@Service()
export class ScreeningRepository {
    constructor(@Inject(DATABASE) private readonly database: DataSource) {}

    private get repo() { return this.database.getRepository(ScreeningEntity); }

    find(id: string): Promise<ScreeningEntity | null> { return this.repo.findOneBy({ id }); }

    // The live (unreleased) screening that holds this order, if any.
    findOrder(key: string): Promise<ScreeningEntity | null> { return this.repo.findOneBy({ order_key: key, released_at: IsNull() }); }

    // Screenings in one scope, completed ones included, plus those released after the
    // cutoff when one is given.
    listByScope(scope: string, releasedAfter?: string): Promise<ScreeningEntity[]> {
        return this.repo.findBy([
            { source_scope: scope, released_at: IsNull() },
            ...(releasedAfter ? [{ source_scope: scope, released_at: MoreThan(releasedAfter) }] : []),
        ]);
    }

    // Every scope: live screenings, and those released after the cutoff.
    listUnfinished(releasedAfter: string): Promise<ScreeningEntity[]> {
        return this.repo.findBy([LIVE, { released_at: MoreThan(releasedAfter) }]);
    }

    findIncomplete(): Promise<ScreeningEntity[]> { return this.repo.findBy(LIVE); }

    // Live screenings with no activity since the cutoff.
    findIdleSince(cutoff: string): Promise<ScreeningEntity[]> {
        return this.repo.findBy({ ...LIVE, last_activity_at: LessThan(cutoff) });
    }

    // Live screenings for these orders. A released screening no longer holds its order.
    async findByOrderKeys(keys: string[]): Promise<ScreeningEntity[]> {
        const rows: ScreeningEntity[] = [];
        for (let i = 0; i < keys.length; i += CHUNK) {
            rows.push(...await this.repo.findBy({ order_key: In(keys.slice(i, i + CHUNK)), released_at: IsNull() }));
        }
        return rows;
    }

    // The manifest, if any, that declares this client capture ID.
    async declaringScreening(clientCaptureId: string): Promise<string | null> {
        const [row] = await this.database.query(
            'SELECT s.id FROM screening s, json_each(s.capture_ids) j WHERE j.value = ? LIMIT 1', [clientCaptureId]);
        return row?.id ?? null;
    }

    // Inserts the manifest only if none of its capture IDs is already declared by another
    // manifest or already used by a capture. This has to be one statement: TypeORM shares
    // a single better-sqlite3 connection, so a read-then-insert from the service could
    // interleave with a concurrent registration and let two manifests claim one capture.
    // Returns false when nothing was inserted; the service decides what that means.
    async insertIfMembersUnclaimed(row: ScreeningEntity): Promise<boolean> {
        await this.database.query(`INSERT OR IGNORE INTO screening
            (id, source_scope, order_key, accession_number, study_instance_uid, step_id, capture_ids, created_at, completed_at, last_activity_at)
            SELECT ?,?,?,?,?,?,?,?,NULL,? WHERE NOT EXISTS (
                SELECT 1 FROM screening s, json_each(s.capture_ids) a, json_each(?) b WHERE a.value = b.value
            ) AND NOT EXISTS (SELECT 1 FROM capture c, json_each(?) b WHERE c.client_capture_id = b.value)`,
            [row.id, row.source_scope, row.order_key, row.accession_number, row.study_instance_uid, row.step_id,
                row.capture_ids, row.created_at, row.last_activity_at, row.capture_ids, row.capture_ids]);
        const [result] = await this.database.query('SELECT changes() AS n');
        return result.n === 1;
    }

    async markCompleted(ids: string[], at: string): Promise<void> {
        for (let i = 0; i < ids.length; i += CHUNK) {
            await this.repo.update({ id: In(ids.slice(i, i + CHUNK)), ...LIVE }, { completed_at: at });
        }
    }

    // Releases a live screening. One conditional UPDATE, so a release racing a completion
    // (or another release) changes at most one of them. Returns whether this call did it.
    async markReleased(id: string, at: string, by: string, reason: ReleaseReason): Promise<boolean> {
        const result = await this.repo.update({ id, ...LIVE }, { released_at: at, released_by: by, release_reason: reason });
        return (result.affected ?? 0) === 1;
    }

    // Releases a screening that is still idle since the cutoff and has no capture queued
    // or sending, re-checked in the same statement as the write, so a capture or retry
    // that lands after the caller's read keeps the screening.
    async markExpiredIfIdle(id: string, at: string, by: string, cutoff: string): Promise<boolean> {
        await this.database.query(`UPDATE screening SET released_at = ?, released_by = ?, release_reason = 'EXPIRED'
            WHERE id = ? AND completed_at IS NULL AND released_at IS NULL AND last_activity_at < ?
            AND NOT EXISTS (SELECT 1 FROM capture c WHERE c.screening_id = screening.id AND c.status IN ('PENDING', 'SENDING'))`,
            [at, by, id, cutoff]);
        const [result] = await this.database.query('SELECT changes() AS n');
        return result.n === 1;
    }

    async touch(id: string, at: string): Promise<void> {
        await this.repo.update({ id, released_at: IsNull() }, { last_activity_at: at });
    }

    // Captures attached to the given manifests, in one indexed query per chunk.
    async capturesOf(screeningIds: string[]): Promise<ScreeningCaptureRow[]> {
        const rows: ScreeningCaptureRow[] = [];
        for (let i = 0; i < screeningIds.length; i += CHUNK) {
            const chunk = screeningIds.slice(i, i + CHUNK);
            rows.push(...await this.database.query(
                `SELECT screening_id, client_capture_id, status, sent_at, id FROM capture
                 WHERE screening_id IN (${chunk.map(() => '?').join(',')})`, chunk));
        }
        return rows;
    }
}
