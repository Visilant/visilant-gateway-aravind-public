import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { TelemetryRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER } from '../../tokens';

const PRUNE_INTERVAL_MS = 10 * 60_000;
const DELETE_CHUNK = 1000;
const DAY_MS = 86_400_000;

// Keeps the telemetry outbox bounded without losing anything central has not confirmed.
//
// Sent rows go after telemetry.retention_days, and oldest first while the table is over
// telemetry.max_outbox_mb. Unsent rows are never deleted. When unsent rows alone are
// over the cap (central unreachable for a long time), the gateway stops taking
// device.health, the most frequent and least valuable type, and keeps everything else.
@Service()
export class TelemetryOutbox {
    private timer: NodeJS.Timeout | null = null;
    private full = false;

    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly repository: TelemetryRepository,
    ) {}

    acceptsDeviceHealth(): boolean {
        return !this.full;
    }

    async start(): Promise<void> {
        await this.prune();
        if (this.timer) return;
        this.timer = setInterval(() => { void this.prune(); }, PRUNE_INTERVAL_MS);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async prune(): Promise<void> {
        try {
            const { max_outbox_mb, retention_days } = this.config.telemetry;
            const capBytes = max_outbox_mb * 1024 * 1024;
            let removed = await this.repository.deleteSentBefore(new Date(Date.now() - retention_days * DAY_MS).toISOString());

            let sizes = await this.repository.sizes();
            while (sizes.total_bytes > capBytes) {
                // Delete in proportion to the excess, so a large overrun is not a
                // thousand round trips and a small one does not empty the table.
                const rows = await this.repository.countAll();
                const excess = Math.ceil(rows * (sizes.total_bytes - capBytes) / sizes.total_bytes);
                const deleted = await this.repository.deleteOldestSent(Math.max(1, Math.min(DELETE_CHUNK, excess)));
                if (deleted === 0) break;
                removed += deleted;
                sizes = await this.repository.sizes();
            }
            if (removed > 0) this.logger.info(`telemetry: pruned ${removed} sent event(s)`);

            const full = sizes.unsent_bytes > capBytes;
            if (full && !this.full) {
                this.logger.error(
                    `telemetry outbox: unsent events alone are over telemetry.max_outbox_mb (${max_outbox_mb} MB). ` +
                    'New device.health events are dropped until central confirms the backlog; crash, capture and AI events are still kept. ' +
                    'Check that the gateway can reach telemetry.central_url, or export the backlog with GET /telemetry/export.'
                );
            } else if (!full && this.full) {
                this.logger.info('telemetry outbox: back under the cap; device.health events are kept again');
            }
            this.full = full;
        } catch (err) {
            this.logger.error(`telemetry prune failed; nothing unsent was deleted and it runs again in 10 min: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
