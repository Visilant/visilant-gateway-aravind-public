import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './options';

// CLI-only DataSource, for `npm run migration:generate` / `migration:run`.
// Deliberately independent of config.json: generating a migration needs a database
// path and the entities, not the centre's DICOM settings.
export default new DataSource(buildDataSourceOptions(process.env.DATABASE_PATH ?? 'data/gateway.db'));
