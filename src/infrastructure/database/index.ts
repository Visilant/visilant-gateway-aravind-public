import { mkdirSync } from 'fs';
import path from 'path';
import { DataSource } from 'typeorm';
import type { GatewayConfig } from '../../config';
import type { Logger } from '../logger';
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

    return dataSource;
}
