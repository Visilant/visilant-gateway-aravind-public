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
import { DiagnosticsService, RetentionService, ScreeningExpiry, SyncWorker, SystemService, TelemetryLifecycle, TelemetryOutbox, TelemetryPushWorker } from './application/services';
import { GatewayServer } from './presentation/server';
import { CONFIG, DATABASE, LOGGER, RECORDER } from './tokens';
import { WorklistSettingsService } from './application/services/WorklistSettingsService';
import { onShutdownRequest, type ShutdownReason } from './shutdown';

// An installed launcher owns this child. Do not leave an orphan queue worker behind
// if Task Scheduler restarts a crashed launcher. Startup recovery handles interruption.
// Until start-up finishes this exits at once; after that it is a clean shutdown.
const exitIfOrphaned = () => process.exit(1);
if (process.send && process.env.GATEWAY_SETUP_TOKEN) process.once('disconnect', exitIfOrphaned);

async function bootstrap(): Promise<void> {
    if (process.env.GATEWAY_DIAGNOSTICS_DIR) await diagnostics.start(path.resolve(process.env.GATEWAY_DIAGNOSTICS_DIR));
    const logger = createLogger();
    Container.set(LOGGER, logger);
    Container.set(RECORDER, diagnostics);

    const config = loadConfig();
    Container.set(CONFIG, config);
    diagnostics.setResourceProbe(() => storageSample(path.resolve(config.storage_root), path.resolve(config.database_path)));
    mkdirSync(path.resolve(config.storage_root), { recursive: true });

    // Opens the database and runs any pending migrations.
    const database = await createDatabase(config, logger);
    Container.set(DATABASE, database);
    await Container.get(WorklistSettingsService).restoreAtBoot();
    if (!config.mwl.requested_procedure_id && !config.mwl.modality && !config.mwl.scheduled_station_ae) {
        // Valid, but almost certainly a commissioning mistake: the worklist will list every
        // open order at the centre, and an operator can capture against the wrong one.
        logger.warn('No worklist filter is set (mwl.requested_procedure_id, mwl.modality or mwl.scheduled_station_ae). The worklist is unfiltered.');
    }

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

    // Before the server: an unclean-shutdown row must be written before anything new.
    const lifecycle = Container.get(TelemetryLifecycle);
    await lifecycle.start().catch((err: unknown) => {
        logger.error(`telemetry: start-up events could not be written; the gateway runs without them: ${err instanceof Error ? err.message : String(err)}`);
    });

    const server = await Container.get(GatewayServer).start();

    const worker = Container.get(SyncWorker);
    worker.start();
    const system = Container.get(SystemService);
    system.start();
    const expiry = Container.get(ScreeningExpiry);
    expiry.start();
    // Prunes at start, then every 10 minutes. Logs its own failures.
    const telemetryOutbox = Container.get(TelemetryOutbox);
    await telemetryOutbox.start();
    const telemetryPush = Container.get(TelemetryPushWorker);
    telemetryPush.start();

    const shutdown = (reason: ShutdownReason) => {
        logger.info(`shutting down (${reason})`);
        worker.stop();
        system.stop();
        expiry.stop();
        telemetryPush.stop();
        telemetryOutbox.stop();
        // gateway.stopped first: server.close can wait on idle phone connections until
        // the forced exit below, and without the row the next start reports a crash.
        const code = reason === 'launcher_gone' ? 1 : 0;
        void lifecycle.stop(reason).finally(() => server.close(() => {
            void diagnostics.stop().then(() => database.destroy()).finally(() => process.exit(code));
        }));
        setTimeout(() => process.exit(code), 5000).unref();
    };
    process.removeListener('disconnect', exitIfOrphaned);
    onShutdownRequest(shutdown);
}

bootstrap().catch((err: unknown) => {
    // The logger may not exist yet (bad config is the common case), so this goes to
    // stderr directly.
    console.error(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
