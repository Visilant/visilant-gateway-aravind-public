import path from 'path';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { TelemetryRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { DiskSpace } from '../../infrastructure/storage';
import { CONFIG, LOGGER } from '../../tokens';

const PRUNE_INTERVAL_MS = 10 * 60_000;
const DISK_INTERVAL_MS = 60_000;
const RESYNC_EVERY_PRUNES = 144; // once a day
const DELETE_CHUNK = 1000;
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
const LIFECYCLE = new Set(['gateway.started', 'gateway.heartbeat', 'gateway.stopped', 'gateway.unclean_shutdown']);

type Level = 'normal' | 'over_outbox_cap' | 'over_unsent_cap';

// Keeps the telemetry outbox bounded without losing anything central has confirmed
// nothing about, and decides what may still be written. See docs/telemetry.md.
//
// Pruning: sent rows go after retention_days, and oldest first while the database file
// holds more than max_outbox_mb. Unsent rows (quarantined included) are never deleted.
//
// Admission, from running totals of unsent rows kept as rows are written and confirmed:
// - past max_outbox_mb: no unsigned rows and no device.health;
// - past max_unsent_mb: only the gateway's own lifecycle rows;
// - under min_free_disk_mb free on the database's or the captures' disk: nothing, so
//   captures always have room.
@Service()
export class TelemetryOutbox {
    private timers: NodeJS.Timeout[] = [];
    private unsent = { count: 0, bytes: 0 };
    private level: Level = 'normal';
    private diskLow = false;
    private prunes = 0;

    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly repository: TelemetryRepository,
        private readonly disk: DiskSpace,
    ) {}

    // `authenticated` is null for the gateway's own rows.
    accepts(type: string, authenticated: boolean | null): boolean {
        if (this.diskLow) return false;
        if (LIFECYCLE.has(type)) return true;
        if (this.level === 'over_unsent_cap') return false;
        if (this.level === 'over_outbox_cap') return authenticated !== false && type !== 'device.health';
        return true;
    }

    unsentCount(): number {
        return this.unsent.count;
    }

    inserted(count: number, bytes: number): void {
        this.unsent = { count: this.unsent.count + count, bytes: this.unsent.bytes + bytes };
        this.updateLevel();
    }

    confirmed({ count, bytes }: { count: number; bytes: number }): void {
        this.unsent = { count: Math.max(0, this.unsent.count - count), bytes: Math.max(0, this.unsent.bytes - bytes) };
        this.updateLevel();
    }

    async start(): Promise<void> {
        try {
            this.unsent = await this.repository.unsentTotals();
            this.updateLevel();
        } catch (err) {
            this.logger.error(`telemetry outbox: could not read the unsent totals; caps apply from new rows only: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.refreshDisk();
        await this.prune();
        if (this.timers.length) return;
        this.timers = [
            setInterval(() => { void this.prune(); }, PRUNE_INTERVAL_MS),
            setInterval(() => { void this.refreshDisk(); }, DISK_INTERVAL_MS),
        ];
        for (const timer of this.timers) timer.unref();
    }

    stop(): void {
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
    }

    async refreshDisk(): Promise<void> {
        const floor = this.config.telemetry.min_free_disk_mb;
        const free = await this.disk.freeBytes([path.dirname(path.resolve(this.config.database_path)), path.resolve(this.config.storage_root)]);
        const low = free !== null && free < floor * MB;
        if (low && !this.diskLow) {
            this.logger.error(`telemetry: less than ${floor} MB free on the gateway's disk. No telemetry is stored until there is more, so captures keep room. Free disk space on this computer.`);
        } else if (!low && this.diskLow) {
            this.logger.info('telemetry: free disk is back above the floor; telemetry is stored again');
        }
        this.diskLow = low;
    }

    async prune(): Promise<void> {
        try {
            const { max_outbox_mb, retention_days } = this.config.telemetry;
            const capBytes = max_outbox_mb * MB;
            let removed = await this.repository.deleteSentBefore(new Date(Date.now() - retention_days * DAY_MS).toISOString());
            while (await this.repository.databaseBytes() > capBytes) {
                const deleted = await this.repository.deleteOldestSent(DELETE_CHUNK);
                if (deleted === 0) break;
                removed += deleted;
            }
            if (removed > 0) {
                await this.repository.reclaimFreePages();
                this.logger.info(`telemetry: pruned ${removed} sent event(s)`);
            }
            // The totals are kept as rows come and go; this catches any drift.
            if (++this.prunes % RESYNC_EVERY_PRUNES === 0) {
                this.unsent = await this.repository.unsentTotals();
                this.updateLevel();
            }
        } catch (err) {
            this.logger.error(`telemetry prune failed; nothing unsent was deleted and it runs again in 10 min: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private updateLevel(): void {
        const { max_outbox_mb, max_unsent_mb } = this.config.telemetry;
        const level: Level = this.unsent.bytes > max_unsent_mb * MB ? 'over_unsent_cap'
            : this.unsent.bytes > max_outbox_mb * MB ? 'over_outbox_cap' : 'normal';
        if (level === this.level) return;
        if (level === 'over_outbox_cap' && this.level === 'normal') {
            this.logger.error(
                `telemetry outbox: unsent events are over telemetry.max_outbox_mb (${max_outbox_mb} MB). ` +
                'Events sent without sign-in and device.health are dropped until central confirms the backlog; signed-in crash, capture and AI events are still kept. ' +
                'Check that the gateway can reach telemetry.central_url, or export the backlog with GET /telemetry/export.'
            );
        } else if (level === 'over_unsent_cap') {
            this.logger.error(
                `telemetry outbox: unsent events are over telemetry.max_unsent_mb (${max_unsent_mb} MB). ` +
                'Only the gateway lifecycle (start, heartbeat, stop) is stored until central confirms the backlog. ' +
                'Check that the gateway can reach telemetry.central_url, or export the backlog with GET /telemetry/export.'
            );
        } else if (level === 'normal') {
            this.logger.info('telemetry outbox: back under the caps; every event is stored again');
        }
        this.level = level;
    }
}
