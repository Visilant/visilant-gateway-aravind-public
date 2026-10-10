import { Inject, Service } from 'typedi';
import type { Logger } from '../../infrastructure/logger';
import { LOGGER } from '../../tokens';
import { ScreeningService } from './ScreeningService';

// Expiry is measured in days, so an hourly check is precise enough and costs nothing.
const INTERVAL_MS = 60 * 60_000;

// Runs the screening inactivity backstop on a timer. The rule lives in
// ScreeningService.expire; this class only decides when it runs.
@Service()
export class ScreeningExpiry {
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly screenings: ScreeningService,
    ) {}

    // Checks once now, so a box that was off for a week catches up at boot, then hourly.
    start(): void {
        void this.run();
        this.timer = setInterval(() => { void this.run(); }, INTERVAL_MS);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async run(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            await this.screenings.expire();
        } catch (err) {
            this.logger.error(`screening expiry check failed, will retry in an hour: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.running = false;
        }
    }
}
