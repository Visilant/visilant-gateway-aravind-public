import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { TelemetryRepository } from '../../infrastructure/database/repositories';
import type { TelemetryEventEntity } from '../../infrastructure/database';
import type { Logger } from '../../infrastructure/logger';
import { CentralClient, CentralPushError } from '../../infrastructure/telemetry';
import { CONFIG, LOGGER } from '../../tokens';
import { TelemetryOutbox } from './TelemetryOutbox';
import { toEnvelope } from './telemetryEnvelope';

export const PUSH_BATCH_SIZE = 500;
const INTERVAL_MS = 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
// Answers from central that leave a row out before the push gives up on it.
export const MAX_UNCONFIRMED_ATTEMPTS = 5;
// Statuses that blame the request, not central. Retrying the same batch cannot help.
const SPLIT_STATUSES = new Set([400, 413, 422]);

// Pushes the telemetry outbox to central, in the order rows were written, the same way SyncWorker drains the capture
// queue: an in-process timer with an overlap guard.
//
// A row is marked sent only when central returns its event_id, and the marks for one
// reply are a single UPDATE. A power cut between central's reply and that UPDATE means
// the rows go again, and central ignores them as duplicates.
//
// A batch central refuses as a request (400, 413, 422) is halved until the refused rows
// are alone; a row refused alone is quarantined. A row central keeps leaving out of its
// answer is quarantined after MAX_UNCONFIRMED_ATTEMPTS. Quarantined rows are kept and
// exported, never pushed again, so one bad row cannot stall the outbox.
//
// Failures back off from 1 to 30 minutes on a monotonic clock, so a wall clock set back
// cannot stall it. The backoff lives in memory: after a restart the first tick simply
// tries again, and the rows were never at risk.
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
        private readonly outbox: TelemetryOutbox,
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
        if (!this.configured || performance.now() < this.nextAttemptAt) return Promise.resolve({ sent: 0 });
        this.running = this.drain().finally(() => { this.running = null; });
        return this.running;
    }

    private async drain(): Promise<{ sent: number }> {
        let sent = 0;
        let quarantined = 0;
        try {
            for (;;) {
                const batch = await this.repository.findPushable(PUSH_BATCH_SIZE);
                if (batch.length === 0) break;
                const result = await this.pushRows(batch);
                sent += result.sent;
                quarantined += result.quarantined;
                if (result.sent + result.quarantined === 0) {
                    throw new CentralPushError('none_confirmed', `central confirmed none of the ${batch.length} events sent`);
                }
                if (batch.length < PUSH_BATCH_SIZE) break;
            }
            this.failures = 0;
            this.nextAttemptAt = 0;
        } catch (err) {
            this.failures += 1;
            const delay = pushBackoffMs(this.failures);
            this.nextAttemptAt = performance.now() + delay;
            this.logger.error(
                `telemetry push failed: ${err instanceof CentralPushError ? err.message : 'unexpected error'}. ` +
                `Rows stay in the outbox; retrying in ${Math.round(delay / 60_000)} min. ${advice(err)}`
            );
            if (!(err instanceof CentralPushError)) this.logger.error(`telemetry push error detail: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (sent) this.logger.info(`telemetry: ${sent} event(s) confirmed by central`);
        if (quarantined) this.logger.warn(`telemetry: ${quarantined} event(s) quarantined this run; they stay in the outbox and are listed in GET /telemetry/export`);
        return { sent };
    }

    private async pushRows(rows: TelemetryEventEntity[]): Promise<{ sent: number; quarantined: number }> {
        const { central_url, central_token } = this.config.telemetry;
        let returned: string[];
        try {
            returned = await this.central.pushBatch(central_url as string, central_token as string, rows.map(toEnvelope));
        } catch (err) {
            if (!(err instanceof CentralPushError) || err.status === null || !SPLIT_STATUSES.has(err.status)) throw err;
            if (rows.length === 1) {
                const reason = `central_${err.status}`;
                await this.repository.quarantine([rows[0].event_id], reason, new Date().toISOString());
                this.logger.warn(`telemetry: 1 event(s) quarantined (${reason}): central refused it on its own`);
                return { sent: 0, quarantined: 1 };
            }
            const middle = Math.ceil(rows.length / 2);
            const first = await this.pushRows(rows.slice(0, middle));
            const second = await this.pushRows(rows.slice(middle));
            return { sent: first.sent + second.sent, quarantined: first.quarantined + second.quarantined };
        }
        const confirmed = new Set(returned);
        const now = new Date().toISOString();
        const marked = await this.repository.markSentMeasured(rows.filter((row) => confirmed.has(row.event_id)).map((row) => row.event_id), now);
        this.outbox.confirmed(marked);
        const sent = marked.count;
        const left = rows.filter((row) => !confirmed.has(row.event_id)).map((row) => row.event_id);
        const quarantined = await this.repository.recordUnconfirmed(left, MAX_UNCONFIRMED_ATTEMPTS, now);
        return { sent, quarantined };
    }
}

// What to check, by failure. The log is all anyone on site has.
function advice(err: unknown): string {
    const status = err instanceof CentralPushError ? err.status : null;
    if (status === 401 || status === 403) return 'Central does not accept telemetry.central_token for this gateway; check the token.';
    if (status !== null && status >= 500) return 'Central is having a problem; nothing to change on this gateway.';
    return 'Check telemetry.central_url, telemetry.central_token and the internet connection.';
}

export function pushBackoffMs(failures: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}
