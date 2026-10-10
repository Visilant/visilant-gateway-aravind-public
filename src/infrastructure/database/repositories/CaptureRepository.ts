import { profile } from '../../../infrastructure/diagnostics';
import { Inject, Service } from 'typedi';
import { DataSource, In, IsNull, LessThanOrEqual, Or, Repository } from 'typeorm';
import { DATABASE } from '../../../tokens';
import { CaptureEntity, CaptureStatus } from '../entities';

// Data access only. Domain verbs (queue, claim, mark sent) live in the services.
@Service()
export class CaptureRepository {
    private readonly repo: Repository<CaptureEntity>;

    private readonly database: DataSource;

    constructor(@Inject(DATABASE) database: DataSource) {
        this.database = database;
        this.repo = database.getRepository(CaptureEntity);
    }

    @profile('db.capture.create')
    async create(data: Partial<CaptureEntity>): Promise<CaptureEntity> {
        const capture = this.repo.create(data);
        // A single INSERT avoids overlapping save transactions on SQLite's connection.
        await this.repo.insert(capture);
        return capture;
    }

    @profile('db.capture.findByClientId')
    findByClientId(clientId: string): Promise<CaptureEntity | null> {
        return this.repo.findOneBy({ client_capture_id: clientId });
    }

    findById(id: string): Promise<CaptureEntity | null> {
        return this.repo.findOneBy({ id });
    }

    @profile('db.capture.findByStatus')
    findByStatus(status: CaptureStatus, limit = 100): Promise<CaptureEntity[]> {
        return this.repo.find({ where: { status }, order: { created_at: 'DESC', id: 'DESC' }, take: limit });
    }

    @profile('db.capture.countInSeries')
    countInSeries(seriesInstanceUid: string): Promise<number> {
        return this.repo.countBy({ series_instance_uid: seriesInstanceUid });
    }

    @profile('db.capture.findRecent')
    findRecent(limit = 100): Promise<CaptureEntity[]> {
        return this.repo.find({ order: { created_at: 'DESC', id: 'DESC' }, take: limit });
    }

    @profile('db.capture.findByStudy')
    findByStudy(studyInstanceUid: string, limit = 100): Promise<CaptureEntity[]> {
        return this.repo.find({
            where: { study_instance_uid: studyInstanceUid },
            order: { created_at: 'DESC', id: 'DESC' },
            take: limit,
        });
    }

    @profile('db.capture.findByDiagnosticRunId')
    findByDiagnosticRunId(runId: string): Promise<CaptureEntity[]> {
        return this.repo.find({ where: { diagnostic_run_id: runId }, order: { created_at: 'ASC', id: 'ASC' } });
    }

    // SENT rows past the retention window, newest first. The caller removes the files of
    // everything it is handed; rows stay.
    @profile('db.capture.findSentBeyond')
    findSentBeyond(offset: number, limit: number): Promise<CaptureEntity[]> {
        return this.repo.find({
            where: { status: CaptureStatus.SENT },
            order: { sent_at: 'DESC', id: 'DESC' },
            skip: offset,
            take: limit,
        });
    }

    // Takes the next batch of due captures and marks them SENDING in one transaction,
    // so a row is never handed out twice even if a tick overlaps the previous one.
    // Timestamps are ISO8601 UTC strings, which compare correctly as text.
    @profile('db.capture.claimDue')
    async claimDue(limit: number, now: string): Promise<CaptureEntity[]> {
        return this.database.transaction(async (manager) => {
            const repo = manager.getRepository(CaptureEntity);
            const due = await repo.find({
                where: {
                    status: CaptureStatus.PENDING,
                    next_attempt_at: Or(IsNull(), LessThanOrEqual(now)),
                },
                order: { created_at: 'ASC' },
                take: limit,
            });

            if (due.length === 0) return [];

            await repo.update({ id: In(due.map((row) => row.id)) }, { status: CaptureStatus.SENDING });
            return due.map((row) => ({ ...row, status: CaptureStatus.SENDING }));
        });
    }

    @profile('db.capture.markSent')
    async markSent(id: string, sentAt: string): Promise<void> {
        await this.repo.update(id, {
            status: CaptureStatus.SENT,
            sent_at: sentAt,
            last_error: null,
            next_attempt_at: null,
        });
    }

    // Back to PENDING with a backoff, or terminally FAILED once retries are exhausted.
    @profile('db.capture.markAttemptFailed')
    async markAttemptFailed(
        id: string,
        attempts: number,
        error: string,
        nextAttemptAt: string | null,
    ): Promise<void> {
        await this.repo.update(id, {
            status: nextAttemptAt ? CaptureStatus.PENDING : CaptureStatus.FAILED,
            attempts,
            last_error: error,
            next_attempt_at: nextAttemptAt,
        });
    }

    // Puts a capture back in the queue for immediate retry. A SENT capture may be re-sent
    // on purpose (same SOP Instance UID, so the archive does not duplicate it); a screening
    // it completed stays completed, because that C-STORE did succeed.
    async requeue(id: string): Promise<void> {
        await this.repo.update(id, {
            status: CaptureStatus.PENDING,
            next_attempt_at: null,
            last_error: null,
        });
    }

    @profile('db.capture.countByStatus')
    async countByStatus(): Promise<Record<CaptureStatus, number>> {
        const rows = await this.repo
            .createQueryBuilder('c')
            .select('c.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .groupBy('c.status')
            .getRawMany<{ status: CaptureStatus; count: number }>();

        const counts = {
            [CaptureStatus.PENDING]: 0,
            [CaptureStatus.SENDING]: 0,
            [CaptureStatus.SENT]: 0,
            [CaptureStatus.FAILED]: 0,
        };
        for (const row of rows) {
            counts[row.status] = Number(row.count);
        }
        return counts;
    }

    async diagnosticSnapshot(now: string): Promise<Record<string, number | null>> {
        const row = await this.repo.createQueryBuilder('c')
            .select('COUNT(*)', 'row_count')
            .addSelect("SUM(c.status = 'PENDING' AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= :now))", 'due')
            .addSelect("SUM(c.status = 'PENDING' AND c.next_attempt_at > :now)", 'deferred')
            .addSelect("MIN(CASE WHEN c.status = 'PENDING' THEN COALESCE(c.enqueued_at,c.created_at) END)", 'oldest')
            .setParameter('now', now).getRawOne();
        return { row_count: Number(row.row_count), due: Number(row.due), deferred: Number(row.deferred), oldest_age_ms: row.oldest ? Date.parse(now) - Date.parse(row.oldest) : null };
    }

    // Returns SENDING rows to PENDING. Single-process gateway, so on startup any row
    // still in SENDING is by definition orphaned by a crash or power loss.
    @profile('db.capture.resetOrphanedSending')
    async resetOrphanedSending(): Promise<number> {
        const result = await this.repo
            .createQueryBuilder()
            .update(CaptureEntity)
            .set({ status: CaptureStatus.PENDING, next_attempt_at: null })
            .where('status = :status', { status: CaptureStatus.SENDING })
            .execute();

        return result.affected ?? 0;
    }
}
