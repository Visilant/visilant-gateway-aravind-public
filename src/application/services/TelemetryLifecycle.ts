import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { TelemetryRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER } from '../../tokens';
import { TelemetryOutbox } from './TelemetryOutbox';
import { TelemetryService } from './TelemetryService';
import pkg from '../../../package.json';

const HEARTBEAT_MS = 60_000;

// The gateway's own up and down periods: gateway.started, a gateway.heartbeat every
// minute, gateway.stopped on a clean shutdown. A power cut writes no stop, so at the
// next start a newest row that is not a stop becomes gateway.unclean_shutdown.
// Central's offline alert reads the heartbeats.
@Service()
export class TelemetryLifecycle {
    private timer: NodeJS.Timeout | null = null;

    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly telemetry: TelemetryService,
        private readonly repository: TelemetryRepository,
        private readonly outbox: TelemetryOutbox,
    ) {}

    async start(): Promise<void> {
        if (!this.config.telemetry.enabled) return;
        const last = await this.repository.newestLifecycle();
        if (last && last.type !== 'gateway.stopped') {
            const restartedAt = new Date().toISOString();
            await this.telemetry.record('gateway.unclean_shutdown', {
                last_heartbeat_at: last.occurred_at,
                restarted_at: restartedAt,
                downtime_s: Math.max(0, Math.round((Date.parse(restartedAt) - Date.parse(last.occurred_at)) / 1000)),
            });
            this.logger.warn(`telemetry: the previous run ended without a clean shutdown; last heartbeat at ${last.occurred_at}`);
        }
        await this.telemetry.record('gateway.started', await this.status());
        this.timer = setInterval(() => { void this.heartbeat(); }, HEARTBEAT_MS);
        this.timer.unref();
    }

    async heartbeat(): Promise<void> {
        try {
            await this.telemetry.record('gateway.heartbeat', await this.status());
        } catch (err) {
            this.logger.error(`telemetry heartbeat could not be written; the gateway keeps running and tries again in a minute: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    stopTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // Before the database closes.
    async stop(): Promise<void> {
        this.stopTimer();
        await this.telemetry.record('gateway.stopped', await this.status()).catch((err: unknown) => {
            this.logger.error(`telemetry: gateway.stopped could not be written, so the next start reports an unclean shutdown: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    private async status(): Promise<Record<string, unknown>> {
        return {
            gateway_version: pkg.version,
            uptime_s: Math.round(process.uptime()),
            outbox_backlog: this.outbox.unsentCount(),
        };
    }
}
