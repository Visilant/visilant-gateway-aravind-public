import { mkdirSync, statSync } from 'fs';
import path from 'path';
import { DataSource } from 'typeorm';
import type { GatewayConfig } from '../../config';
import type { Logger } from '../logger';
import { DiskSpace } from '../storage/DiskSpace';
import { buildDataSourceOptions } from './options';

export * from './entities';
export { buildDataSourceOptions } from './options';

// Opens the database and brings the schema up to date.
//
// Migrations run at startup, not as a deploy step: there is no ops person on this box,
// and a new installer landing on a machine that still holds unsent captures has to
// upgrade in place without losing them.
export async function createDatabase(config: GatewayConfig, logger: Logger): Promise<DataSource> {
    mkdirSync(path.dirname(path.resolve(config.database_path)), { recursive: true });

    const dataSource = new DataSource({
        ...buildDataSourceOptions(config.database_path),
        migrationsRun: false,
    });

    await dataSource.initialize();

    const applied = await dataSource.runMigrations();
    if (applied.length > 0) {
        logger.info(`applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`);
    }

    await ensureIncrementalVacuum(dataSource, config.database_path, logger);
    return dataSource;
}

const INCREMENTAL = 2;

// A database made before auto_vacuum was set needs one VACUUM to switch. It rewrites the
// file, so it needs about the file's size free again, and is skipped (and retried at
// the next start) when that is not there. Deleting rows still frees pages for reuse
// without it; only the file does not shrink.
async function ensureIncrementalVacuum(dataSource: DataSource, databasePath: string, logger: Logger): Promise<void> {
    const [mode] = await dataSource.query('PRAGMA auto_vacuum') as Array<{ auto_vacuum: number }>;
    if (Number(mode.auto_vacuum) === INCREMENTAL) return;
    const file = path.resolve(databasePath);
    const size = statSync(file).size;
    const free = await new DiskSpace().freeBytes([path.dirname(file)]);
    if (free !== null && free < size * 2 + 1024 * 1024 * 1024) {
        logger.warn('database: not enough free disk to switch to incremental vacuum now; it is tried again at the next start. Free some disk space.');
        return;
    }
    await dataSource.query('PRAGMA auto_vacuum = INCREMENTAL');
    await dataSource.query('VACUUM');
    logger.info('database: switched to incremental vacuum, so pruned telemetry gives disk space back');
}
