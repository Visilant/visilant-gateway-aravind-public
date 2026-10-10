import { diagnostics } from './infrastructure/diagnostics';
import { storageSample } from './infrastructure/diagnostics/sampler';
import 'reflect-metadata';
import { mkdirSync } from 'fs';
import path from 'path';
import Container from 'typedi';
import { loadConfig } from './config';
import { createLogger } from './infrastructure/logger';
import { createDatabase } from './infrastructure/database';
import { CaptureRepository } from './infrastructure/database/repositories';
import { DiagnosticsService, RetentionService, ScreeningExpiry, SyncWorker, SystemService } from './application/services';
import { GatewayServer } from './presentation/server';
import { CONFIG, DATABASE, LOGGER, RECORDER } from './tokens';

// An installed launcher owns this child. Do not leave an orphan queue worker behind
// if Task Scheduler restarts a crashed launcher. Startup recovery handles interruption.
if (process.send && process.env.GATEWAY_SETUP_TOKEN) process.once('disconnect', () => process.exit(1));

async function bootstrap(): Promise<void> {
    if (process.env.GATEWAY_DIAGNOSTICS_DIR) await diagnostics.start(path.resolve(process.env.GATEWAY_DIAGNOSTICS_DIR));
    const logger = createLogger();
    Container.set(LOGGER, logger);
    Container.set(RECORDER, diagnostics);

    const config = loadConfig();
    Container.set(CONFIG, config);
    diagnostics.setResourceProbe(() => storageSample(path.resolve(config.storage_root), path.resolve(config.database_path)));
    if (!config.mwl.requested_procedure_id && !config.mwl.modality && !config.mwl.scheduled_station_ae) {
        // Valid, but almost certainly a commissioning mistake: the worklist will list every
        // open order at the centre, and an operator can capture against the wrong one.
        logger.warn('No worklist filter is set (mwl.requested_procedure_id, mwl.modality or mwl.scheduled_station_ae). The worklist is unfiltered.');
    }
    mkdirSync(path.resolve(config.storage_root), { recursive: true });

    // Opens the database and runs any pending migrations.
    const database = await createDatabase(config, logger);
    Container.set(DATABASE, database);

    // Boot recovery. This box loses power mid-send as a matter of routine, and a row
    // left in SENDING has no other owner to reclaim it — without this, those captures
    // are silently stranded forever.
    const orphaned = await Container.get(CaptureRepository).resetOrphanedSending();
    if (orphaned > 0) {
        logger.warn(`recovered ${orphaned} capture(s) left mid-send by a previous run`);
    }

    // Under KEEP, bring a box that ran unbounded before this release down to the window.
    await Container.get(RetentionService).prune('full').catch(() => {
        logger.error('retention: boot prune failed; sent files will be retried after the next delivery');
    });
    await Container.get(DiagnosticsService).restoreAtBoot();

    const server = await Container.get(GatewayServer).start();

    const worker = Container.get(SyncWorker);
    worker.start();
    const system = Container.get(SystemService);
    system.start();
    const expiry = Container.get(ScreeningExpiry);
    expiry.start();

    const shutdown = (signal: string) => {
        logger.info(`${signal} received, shutting down`);
        worker.stop();
        system.stop();
        expiry.stop();
        server.close(() => {
            void diagnostics.stop().then(() => database.destroy()).finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
    // The logger may not exist yet (bad config is the common case), so this goes to
    // stderr directly.
    console.error(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
