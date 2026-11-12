import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import type { TelemetryEventEntity } from '../../infrastructure/database';
import { TelemetryRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { CentralClient, CentralPushError } from '../../infrastructure/telemetry';
import { CONFIG, LOGGER } from '../../tokens';

export const PUSH_BATCH_SIZE = 500;
const INTERVAL_MS = 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// Pushes the telemetry outbox to central, the same way SyncWorker drains the capture
// queue: an in-process timer with an overlap guard.
//
// A row is marked sent only when central returns its event_id, and the marks for one
// reply are a single UPDATE. A power cut between central's reply and that UPDATE means
// the rows go again, and central ignores them as duplicates.
//
// Failures back off from 1 to 30 minutes. The backoff lives in memory: after a restart
// the first tick simply tries again, and the rows were never at risk.
@Service()
export class TelemetryPushWorker {
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<{ sent: number }> | null = null;
    private failures = 0;
    private nextAttemptAt = 0;

    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly repository: TelemetryRepository,
        private readonly central: CentralClient,
    ) {}

    private get configured(): boolean {
        const telemetry = this.config.telemetry;
        return telemetry.enabled && !!telemetry.central_url && !!telemetry.central_token;
    }

    start(): void {
        if (!this.configured || this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, INTERVAL_MS);
        this.timer.unref();
        this.logger.info('telemetry push started, every 60s');
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // Right away, for a backlog past one batch. A backoff in progress still applies.
    async kick(): Promise<void> {
        await this.tick();
    }

    tick(): Promise<{ sent: number }> {
        // One push at a time: a second caller shares the running one rather than sending
        // the same unsent rows in parallel.
        if (this.running) return this.running;
        if (!this.configured || Date.now() < this.nextAttemptAt) return Promise.resolve({ sent: 0 });
        this.running = this.drain().finally(() => { this.running = null; });
        return this.running;
    }

    private async drain(): Promise<{ sent: number }> {
        const { central_url, central_token } = this.config.telemetry;
        let sent = 0;
        try {
            for (;;) {
                const batch = await this.repository.findUnsent(PUSH_BATCH_SIZE);
                if (batch.length === 0) break;
                const returned = new Set(await this.central.pushBatch(central_url as string, central_token as string, batch.map(envelope)));
                const confirmed = batch.filter((row) => returned.has(row.event_id)).map((row) => row.event_id);
                sent += await this.repository.markSent(confirmed, new Date().toISOString());
                if (confirmed.length === 0) {
                    throw new CentralPushError('none_confirmed', `central confirmed none of the ${batch.length} events sent`);
                }
                if (batch.length < PUSH_BATCH_SIZE) break;
            }
            this.failures = 0;
            this.nextAttemptAt = 0;
        } catch (err) {
            this.failures += 1;
            const delay = pushBackoffMs(this.failures);
            this.nextAttemptAt = Date.now() + delay;
            const reason = err instanceof CentralPushError ? err.message : 'unexpected error';
            this.logger.error(
                `telemetry push failed: ${reason}. Rows stay in the outbox; retrying in ${Math.round(delay / 60_000)} min. ` +
                'Check telemetry.central_url, telemetry.central_token and the internet connection.'
            );
            if (!(err instanceof CentralPushError)) this.logger.error(`telemetry push error detail: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (sent) this.logger.info(`telemetry: ${sent} event(s) confirmed by central`);
        return { sent };
    }
}

// The row as it is stored centrally: the envelope, payload as an object, no sent_at.
function envelope(row: TelemetryEventEntity): object {
    const { sent_at: _sentAt, payload, ...rest } = row;
    return { ...rest, payload: JSON.parse(payload) as unknown };
}

export function pushBackoffMs(failures: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}
