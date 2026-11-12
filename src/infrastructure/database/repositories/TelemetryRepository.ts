import { Inject, Service } from 'typedi';
import { DataSource, Repository } from 'typeorm';
import { DATABASE } from '../../../tokens';
import { TelemetryEventEntity } from '../entities';

const COLUMNS = ['event_id', 'schema_version', 'type', 'occurred_at', 'received_at', 'site_id', 'gateway_id',
    'device_id', 'session_id', 'capture_id', 'screening_id', 'authenticated', 'payload', 'sent_at'] as const;
const LIFECYCLE = ['gateway.started', 'gateway.heartbeat', 'gateway.stopped'];

// Approximate bytes a row takes: its text plus a fixed allowance for the row header and
// the two indexes. Close enough for a cap that is a first guess, and cheap to compute.
const ROW_OVERHEAD_BYTES = 200;
const ROW_BYTES = `(${ROW_OVERHEAD_BYTES} + LENGTH(payload) + LENGTH(event_id) + LENGTH(type) + LENGTH(occurred_at) + LENGTH(received_at)`
    + ' + LENGTH(site_id) + LENGTH(gateway_id) + COALESCE(LENGTH(device_id), 0) + COALESCE(LENGTH(session_id), 0)'
    + ' + COALESCE(LENGTH(capture_id), 0) + COALESCE(LENGTH(screening_id), 0) + COALESCE(LENGTH(sent_at), 0))';

// Data access for the telemetry outbox. What to keep, send or prune is decided in the
// telemetry services.
@Service()
export class TelemetryRepository {
    private readonly repo: Repository<TelemetryEventEntity>;

    constructor(@Inject(DATABASE) private readonly database: DataSource) {
        this.repo = database.getRepository(TelemetryEventEntity);
    }

    // One INSERT OR IGNORE statement for the whole batch, never an explicit transaction.
    // TypeORM's better-sqlite3 driver shares one connection, so a second BEGIN while
    // another transaction is open (the capture queue's claimDue, for one) makes both
    // fail. A single statement is atomic on its own.
    //
    // Returns, per row, whether it was new. A retry from the phone, or the same event
    // twice in a batch, is ignored, and only its first copy counts as new.
    async insertOrIgnore(rows: TelemetryEventEntity[]): Promise<boolean[]> {
        if (rows.length === 0) return [];
        const placeholders = `(${COLUMNS.map(() => '?').join(', ')})`;
        const sql = `INSERT OR IGNORE INTO "telemetry_event" (${COLUMNS.map(c => `"${c}"`).join(', ')}) `
            + `VALUES ${rows.map(() => placeholders).join(', ')} RETURNING "event_id"`;
        // SQLite has no boolean: TypeORM stores the column as 1 or 0.
        const values = rows.flatMap((row) => COLUMNS.map((c) => typeof row[c] === 'boolean' ? (row[c] ? 1 : 0) : row[c] ?? null));
        const returned = await this.database.query(sql, values) as Array<{ event_id: string }>;
        const fresh = new Set(returned.map((r) => r.event_id));
        return rows.map((row) => fresh.delete(row.event_id));
    }

    // The next rows to push: unsent and not quarantined, in the order they were written.
    findPushable(limit: number): Promise<TelemetryEventEntity[]> {
        return this.repo.createQueryBuilder('t')
            .where('t.sent_at IS NULL').andWhere('t.quarantined_at IS NULL')
            .orderBy('t.seq', 'ASC').limit(limit).getMany();
    }

    // Every unsent row, quarantined ones included, written after `afterSeq`.
    findUnsent(limit: number, afterSeq = 0): Promise<TelemetryEventEntity[]> {
        return this.repo.createQueryBuilder('t')
            .where('t.sent_at IS NULL').andWhere('t.seq > :after', { after: afterSeq })
            .orderBy('t.seq', 'ASC').limit(limit).getMany();
    }

    async seqOf(eventId: string): Promise<number | null> {
        const row = await this.repo.findOne({ where: { event_id: eventId }, select: { seq: true } });
        return row?.seq ?? null;
    }

    countAll(): Promise<number> {
        return this.repo.count();
    }

    countUnsent(): Promise<number> {
        return this.repo.createQueryBuilder('t').where('t.sent_at IS NULL').getCount();
    }

    // One UPDATE, so it is one transaction: either every confirmed id is marked or none.
    async markSent(eventIds: string[], sentAt: string): Promise<number> {
        if (eventIds.length === 0) return 0;
        const result = await this.repo.createQueryBuilder().update(TelemetryEventEntity)
            .set({ sent_at: sentAt })
            .where('event_id IN (:...ids)', { ids: eventIds })
            .andWhere('sent_at IS NULL')
            .execute();
        return result.affected ?? 0;
    }

    // The last gateway.started, heartbeat or stopped row written.
    newestLifecycle(): Promise<TelemetryEventEntity | null> {
        return this.repo.createQueryBuilder('t')
            .where('t.type IN (:...types)', { types: LIFECYCLE })
            .andWhere('t.device_id IS NULL')
            // Written order, not event_id: the clock may have jumped since.
            .orderBy('t.seq', 'DESC')
            .getOne();
    }

    async sizes(): Promise<{ total_bytes: number; unsent_bytes: number }> {
        const result = await this.repo.createQueryBuilder('t')
            .select(`COALESCE(SUM(${ROW_BYTES}), 0)`, 'total')
            .addSelect(`COALESCE(SUM(CASE WHEN sent_at IS NULL THEN ${ROW_BYTES} ELSE 0 END), 0)`, 'unsent')
            .getRawOne<{ total: number; unsent: number }>();
        return { total_bytes: Number(result?.total ?? 0), unsent_bytes: Number(result?.unsent ?? 0) };
    }

    async deleteSentBefore(cutoff: string): Promise<number> {
        const result = await this.repo.createQueryBuilder().delete().from(TelemetryEventEntity)
            .where('sent_at IS NOT NULL')
            .andWhere('occurred_at < :cutoff', { cutoff })
            .execute();
        return result.affected ?? 0;
    }

    // Sent rows only, oldest occurred_at first.
    async deleteOldestSent(limit: number): Promise<number> {
        const result = await this.repo.createQueryBuilder().delete().from(TelemetryEventEntity)
            .where('event_id IN (SELECT event_id FROM telemetry_event WHERE sent_at IS NOT NULL ORDER BY occurred_at ASC, seq ASC LIMIT :limit)', { limit })
            .execute();
        return result.affected ?? 0;
    }
}
