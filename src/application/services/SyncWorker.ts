import { diagnosticContext, diagnostics, diagnosticSpan, profile } from '../../infrastructure/diagnostics';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import type { CaptureEntity } from '../../infrastructure/database';
import { CaptureRepository } from '../../infrastructure/database/repositories';
import { DicomStoreClient } from '../../infrastructure/dicom';
import type { Logger } from '../../infrastructure/logger';
import { LocalDiskStorage } from '../../infrastructure/storage';
import { CONFIG, LOGGER } from '../../tokens';
import { RetentionService } from './RetentionService';

const BATCH_SIZE = 10;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// Drains the capture queue to the archive.
//
// Runs in-process on a fixed interval. There is no external scheduler on this box, and
// the work is naturally single-writer, so a timer with an overlap guard is the whole
// mechanism — no cron expressions for a machine nobody administers.
@Service()
export class SyncWorker {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private pending = false;

    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly captureRepository: CaptureRepository,
        private readonly storeClient: DicomStoreClient,
        private readonly storage: LocalDiskStorage,
        private readonly retention: RetentionService,
    ) {}

    start(): void {
        const intervalMs = this.config.sync_interval_seconds * 1000;
        this.timer = setInterval(() => {
            void this.tick().catch((err: unknown) => {
                this.logger.error(`sync tick failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, intervalMs);
        // Do not hold the process open purely for the timer.
        this.timer.unref();
        this.logger.info(`sync worker started, every ${this.config.sync_interval_seconds}s`);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // Exposed so a capture can be sent the moment it is queued, and so an operator can
    // drain without waiting for the next interval.
    @profile('queue.tick')
    async tick(): Promise<{ sent: number; failed: number }> {
        // A tick raised while one is already running marks the queue dirty rather than
        // being dropped. Without this, a capture committed just after the running tick
        // claimed its batch would wait a full interval even though the archive is up —
        // which is exactly what happens when an operator photographs both eyes quickly.
        if (this.running) {
            diagnostics.event('queue.overlap');
            this.pending = true;
            return { sent: 0, failed: 0 };
        }

        this.running = true;
        try {
            let sent = 0;
            let failed = 0;

            do {
                this.pending = false;
                const batch = await this.drain();
                sent += batch.sent;
                failed += batch.failed;
            } while (this.pending);

            if (sent || failed) {
                this.logger.info(`sync: ${sent} sent, ${failed} failed`);
            }
            return { sent, failed };
        } finally {
            this.running = false;
        }
    }

    private async drain(): Promise<{ sent: number; failed: number }> {
        if (diagnostics.enabled) {
            try { diagnostics.event('queue.snapshot', await this.captureRepository.diagnosticSnapshot(new Date().toISOString())); }
            catch { diagnostics.event('queue.snapshot', { error_code: 'sample_unavailable' }, undefined, 'error'); }
        }
        const due = await this.captureRepository.claimDue(BATCH_SIZE, new Date().toISOString());
        let sent = 0;
        let failed = 0;

        for (const capture of due) {
            if (await diagnosticContext.run({ run_id: capture.diagnostic_run_id, operation_id: capture.diagnostic_operation_id }, () => diagnosticSpan('delivery.attempt', () => this.send(capture), { attempt: capture.attempts + 1, queue_wait_ms: capture.enqueued_at ? Date.now() - Date.parse(capture.enqueued_at) : null }))) sent++;
            else failed++;
        }
        return { sent, failed };
    }

    private async send(capture: CaptureEntity): Promise<boolean> {
        try {
            if (!(await this.storage.exists(capture.dicom_path))) {
                // Nothing will ever make this file reappear, so retrying is pointless.
                await this.captureRepository.markAttemptFailed(
                    capture.id,
                    capture.attempts + 1,
                    'the DICOM file is missing from local storage',
                    null
                );
                this.logger.error(`capture ${capture.id}: DICOM file missing, marked failed`);
                return false;
            }

            await this.storeClient.store(this.storage.absolutePath(capture.dicom_path), this.config.store);
            await this.captureRepository.markSent(capture.id, new Date().toISOString());
            diagnostics.event('capture.delivered', { elapsed_ms: capture.enqueued_at ? Date.now() - Date.parse(capture.enqueued_at) : null });

            // Only now, with the archive's acknowledgement in hand, is the local copy
            // redundant. Deleting any earlier would lose the photograph on a failure.
            if (this.config.retention === 'DELETE_ON_SENT') {
                await this.storage.remove(capture.dicom_path).catch((err: unknown) => {
                    this.logger.error(
                        `capture ${capture.id} was stored but its local file could not be removed: ` +
                        `${err instanceof Error ? err.message : String(err)}`
                    );
                });
            } else {
                // KEEP: this file stays; the oldest sent file beyond the window goes.
                await this.retention.prune('incremental').catch((err: unknown) => {
                    this.logger.error(`retention prune after capture ${capture.id} failed: ${err instanceof Error ? err.message : String(err)}`);
                });
            }

            this.logger.info(`capture ${capture.id} stored to archive`);
            return true;
        } catch (err) {
            const attempts = capture.attempts + 1;
            const message = err instanceof Error ? err.message : String(err);
            const nextAttemptAt = attempts >= this.config.max_send_attempts
                ? null
                : new Date(Date.now() + backoffMs(attempts)).toISOString();

            await this.captureRepository.markAttemptFailed(capture.id, attempts, message, nextAttemptAt);
            diagnostics.event('capture.delivery_failed', { attempt: attempts, deferred: nextAttemptAt !== null }, undefined, 'error');

            if (nextAttemptAt) {
                this.logger.warn(`capture ${capture.id} attempt ${attempts} failed, retrying after ${nextAttemptAt}`);
            } else {
                // Terminal, but recoverable by hand: a capture that has failed this many
                // times needs a person to look, and POST /captures/:id/retry puts it back.
                this.logger.error(
                    `capture ${capture.id} failed after ${attempts} attempts and needs attention: ${message}`
                );
            }
            return false;
        }
    }
}

// Exponential with a ceiling. The common failure is an archive that is down for a
// while, so retries back off to every half hour rather than hammering it.
function backoffMs(attempts: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}
