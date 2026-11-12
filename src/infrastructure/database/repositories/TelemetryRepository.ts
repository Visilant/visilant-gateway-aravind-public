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
        return (await this.insert(rows)).inserted;
    }

    // insertOrIgnore, plus the estimated bytes of the rows that were new.
    async insert(rows: TelemetryEventEntity[]): Promise<{ inserted: boolean[]; bytes: number }> {
        if (rows.length === 0) return { inserted: [], bytes: 0 };
        const placeholders = `(${COLUMNS.map(() => '?').join(', ')})`;
        const sql = `INSERT OR IGNORE INTO "telemetry_event" (${COLUMNS.map(c => `"${c}"`).join(', ')}) `
            + `VALUES ${rows.map(() => placeholders).join(', ')} RETURNING "event_id", ${ROW_BYTES} AS "bytes"`;
        // SQLite has no boolean: TypeORM stores the column as 1 or 0.
        const values = rows.flatMap((row) => COLUMNS.map((c) => typeof row[c] === 'boolean' ? (row[c] ? 1 : 0) : row[c] ?? null));
        const returned = await this.database.query(sql, values) as Array<{ event_id: string; bytes: number }>;
        const fresh = new Set(returned.map((r) => r.event_id));
        return {
            inserted: rows.map((row) => fresh.delete(row.event_id)),
            bytes: returned.reduce((sum, r) => sum + Number(r.bytes), 0),
        };
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

    countUnsent(): Promise<number> {
        return this.repo.createQueryBuilder('t').where('t.sent_at IS NULL').getCount();
    }

    // One UPDATE, so it is one transaction: either every confirmed id is marked or none.
    async markSent(eventIds: string[], sentAt: string): Promise<number> {
        return (await this.markSentMeasured(eventIds, sentAt)).count;
    }

    // markSent, plus the estimated bytes those rows took while unsent.
    async markSentMeasured(eventIds: string[], sentAt: string): Promise<{ count: number; bytes: number }> {
        if (eventIds.length === 0) return { count: 0, bytes: 0 };
        // Bytes as they were before sent_at was set, to match what insert() counted.
        const rows = await this.database.query(
            `UPDATE "telemetry_event" SET "sent_at" = ? WHERE "event_id" IN (${eventIds.map(() => '?').join(', ')}) AND "sent_at" IS NULL `
            + `RETURNING ${ROW_BYTES} - LENGTH("sent_at") AS "bytes"`,
            [sentAt, ...eventIds],
        ) as Array<{ bytes: number }>;
        return { count: rows.length, bytes: rows.reduce((sum, r) => sum + Number(r.bytes), 0) };
    }

    // Unsent rows, quarantined included. A full scan: for start-up and the daily resync.
    async unsentTotals(): Promise<{ count: number; bytes: number }> {
        const row = (await this.database.query(
            `SELECT COUNT(*) AS "count", COALESCE(SUM(${ROW_BYTES}), 0) AS "bytes" FROM "telemetry_event" WHERE "sent_at" IS NULL`,
        ))[0] as { count: number; bytes: number };
        return { count: Number(row.count), bytes: Number(row.bytes) };
    }

    // Bytes the whole database file holds in live pages. Constant time.
    async databaseBytes(): Promise<number> {
        const [pages] = await this.database.query('PRAGMA page_count') as Array<{ page_count: number }>;
        const [free] = await this.database.query('PRAGMA freelist_count') as Array<{ freelist_count: number }>;
        const [size] = await this.database.query('PRAGMA page_size') as Array<{ page_size: number }>;
        return (Number(pages.page_count) - Number(free.freelist_count)) * Number(size.page_size);
    }

    // Gives free pages back to the file system (with auto_vacuum = INCREMENTAL).
    // incremental_vacuum frees one page per step, and a plain query takes one step, so
    // this goes through better-sqlite3's pragma(), which steps it to the end. One
    // synchronous call: nothing can interleave with it.
    async reclaimFreePages(): Promise<void> {
        const native = (this.database.driver as unknown as { databaseConnection: { pragma(source: string): unknown } }).databaseConnection;
        native.pragma('incremental_vacuum');
    }

    async quarantine(eventIds: string[], reason: string, at: string): Promise<number> {
        if (eventIds.length === 0) return 0;
        const result = await this.repo.createQueryBuilder().update(TelemetryEventEntity)
            .set({ quarantined_at: at, quarantine_reason: reason })
            .where('event_id IN (:...ids)', { ids: eventIds }).andWhere('sent_at IS NULL')
            .execute();
        return result.affected ?? 0;
    }

    // One more answer from central that left these rows out. Rows that reach
    // `maxAttempts` are quarantined in the same statement. Returns how many were.
    async recordUnconfirmed(eventIds: string[], maxAttempts: number, at: string): Promise<number> {
        if (eventIds.length === 0) return 0;
        const rows = await this.database.query(
            `UPDATE "telemetry_event" SET "push_attempts" = "push_attempts" + 1,
                "quarantined_at" = CASE WHEN "push_attempts" + 1 >= ? THEN ? ELSE "quarantined_at" END,
                "quarantine_reason" = CASE WHEN "push_attempts" + 1 >= ? THEN 'unconfirmed' ELSE "quarantine_reason" END
             WHERE "event_id" IN (${eventIds.map(() => '?').join(', ')}) AND "sent_at" IS NULL
             RETURNING "quarantined_at"`,
            [maxAttempts, at, maxAttempts, ...eventIds],
        ) as Array<{ quarantined_at: string | null }>;
        return rows.filter((row) => row.quarantined_at !== null).length;
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
