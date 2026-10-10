import path from 'path';
import type { BetterSqlite3ConnectionOptions } from 'typeorm/driver/better-sqlite3/BetterSqlite3ConnectionOptions';
import { CaptureEntity, ScreeningEntity, SettingEntity, UserEntity } from './entities';

// Resolves to ./migrations in source and build/migrations once compiled.
const MIGRATIONS_GLOB = path.join(__dirname, '../../../migrations/*.{ts,js}');

// Three pragmas that are not optional on this deployment:
//   foreign_keys  — OFF by default in SQLite, silently, on every connection. Without
//                   it the capture -> user FK is decorative.
//   journal_mode  — WAL, so the API can read while the worker writes. Without it,
//                   normal concurrent use produces SQLITE_BUSY.
//   busy_timeout  — default is 0, i.e. fail instantly rather than wait briefly.
export function buildDataSourceOptions(databasePath: string): BetterSqlite3ConnectionOptions {
    return {
        type: 'better-sqlite3',
        database: databasePath,
        entities: [CaptureEntity, ScreeningEntity, SettingEntity, UserEntity],
        migrations: [MIGRATIONS_GLOB],
        synchronize: false,
        prepareDatabase: (db) => {
            db.pragma('journal_mode = WAL');
            db.pragma('foreign_keys = ON');
            db.pragma('busy_timeout = 5000');
        },
    };
}
