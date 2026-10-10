# Development

How to run the gateway on your own computer, test it, and make the most common changes.

## Requirements

| Tool | Why | Install |
|---|---|---|
| **Node 22** | Runtime. `package.json` allows only 22. `better-sqlite3` has Windows prebuilds for Node 20 and 22 but not 24 | `nvm install 22 && nvm use` (`.nvmrc` pins it) |
| **DCMTK** | `findscu`, `img2dcm`, `storescu`, `echoscu`, `dcm2json`, `dcmdump`, `dcmodify` | `brew install dcmtk` or `apt install dcmtk` |
| **ImageMagick 7** | `magick`, to turn rotated or progressive JPEGs upright | `brew install imagemagick`. On Ubuntu (ImageMagick 6), link `convert` as `magick` |
| **Docker** | Local test PACS and worklist (dcm4chee) | Docker Desktop or Docker Engine |

The tools must be on `PATH`, or you can point to each one with an environment variable
(`FINDSCU_BIN`, `MAGICK_BIN`, ...). See [configuration.md](configuration.md#environment).

## First run

```bash
nvm use
npm ci
docker compose -f dev/docker-compose.pacs.yml up -d
```

The archive takes one to two minutes to start the first time. It is ready when
`echoscu localhost 11112 -aec DCM4CHEE -aet VISILANT` returns without error.

| Local archive | |
|---|---|
| DIMSE (C-ECHO, C-FIND, C-STORE) | `localhost:11112` |
| Worklist AE title | `WORKLIST` |
| Archive AE title | `DCM4CHEE` |
| Web viewer | http://localhost:8008/dcm4chee-arc/ui2 |

Make a `config.json`:

```json
{
  "centre_code": "DEV",
  "listen_port": 8080,
  "storage_root": "captures",
  "database_path": "data/gateway.db",
  "study_uid_root": "1.2.826.0.1.3680043.10.1338",
  "mwl":   { "host": "localhost", "port": 11112, "called_ae": "WORKLIST", "calling_ae": "VISILANT", "scheduled_station_ae": "VISILANT" },
  "store": { "host": "localhost", "port": 11112, "called_ae": "DCM4CHEE", "calling_ae": "VISILANT" }
}
```

Then:

```bash
node dev/seed-mwl.mjs 5                                # five test orders, station VISILANT, modality OP
npm run users -- add dev@example.org dev --admin       # prints a password once
npm run dev
```

Check it:

```bash
curl -s localhost:8080/health
TOKEN=$(curl -s localhost:8080/signin -H 'content-type: application/json' \
  -d '{"email":"dev@example.org","password":"<password>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
curl -s localhost:8080/worklist -H "authorization: Bearer $TOKEN"
```

The operator page is at http://localhost:8080/ui. Under `npm run dev` it is served from
`src/presentation/ui`. `npm run build` copies it to `build/` for `npm start`.

The test data from `dev/seed-mwl.mjs` is made up. Never use real patient data in
development.

## Tests

| Command | What it runs |
|---|---|
| `npm test -- --runInBand` | All Jest tests. The tests that need real DCMTK are skipped |
| `TEST_DCMTK=1 npm test -- --runInBand` | Also builds and reads real DICOM files with DCMTK and ImageMagick |
| `npm run e2e` | Builds the gateway, starts the local archive if needed, seeds its own orders, and drives two real gateways over HTTP the way the phone does: worklist, upload, delivery, PACS outage, back-off, `FAILED` and retry, power cut in the middle of a send, repeated uploads. Add `-- --keep` to keep its temporary folders and logs |
| `npm run check` | Typecheck, tests and build. CI runs the same steps |

Tests live in `tests/`, one file per unit (`worklist-client.test.ts`,
`capture-service.test.ts`, `sync-worker.test.ts`, ...).

## Database changes

The schema is defined by the entities in `src/infrastructure/database/entities/`.

1. Change the entity.
2. Generate the migration: `npm run migration:generate -- migrations/DescribeTheChange`.
   Never write one by hand.
3. **Read it.** SQLite cannot add a constraint to a table, so TypeORM rebuilds the table
   (create, copy, drop, rename). That is correct but long.
4. Apply it with `npm run migration:run`, then run
   `npm run migration:generate -- migrations/Check` and confirm that it reports no changes.
5. Commit the entity and the migration together.

Migrations run automatically at start-up on every installed gateway. A migration that
fails, or that loses data, breaks a centre's gateway with no one on site to fix it.

## Recipes

### Change the worklist filter

No code change: edit `mwl.requested_procedure_id`, `mwl.modality` or
`mwl.scheduled_station_ae` in `config.json` and restart. See
[worklist.md](worklist.md#the-three-filters).

### Add a worklist filter or a returned field

See [worklist.md](worklist.md#changing-the-worklist-query).

### Add or change a DICOM tag

See [dicom-output.md](dicom-output.md#changing-the-dicom-output).

### Add a config setting

1. Add the property with class-validator rules to `src/config/config.schema.ts`. A nested
   object needs both `@ValidateNested()` and `@IsDefined()`: `@ValidateNested()` alone
   accepts a missing object.
2. If the setup wizard should show it, add a field in `src/presentation/ui/setup/setup.js`
   and a default in `defaultConfig` in `src/setup/SetupService.ts`.
3. Add it to `config.example.json` if every site needs it.
4. Test it in `tests/config.test.ts`.
5. Add it to [configuration.md](configuration.md).

### Add an HTTP endpoint

1. Request DTO in `src/application/dto/` with class-validator rules.
2. Logic in a service in `src/application/services/` (`@Service()`).
3. A controller method in `src/presentation/controllers/` that only calls the service.
   Protect it with `@Authorized()`. Map domain errors to HTTP errors in the controller.
4. Register a new controller in `src/presentation/server.ts`.
5. Test in `tests/server-routes.test.ts` or a new test file.
6. Document it in [api.md](api.md).

### Change how often or how many times the gateway retries

`sync_interval_seconds` and `max_send_attempts` in `config.json`. The back-off (30 s
doubling to 30 min) is `BACKOFF_BASE_MS` and `BACKOFF_CAP_MS` in
`src/application/services/SyncWorker.ts`.

## Build the Windows bundle

The bundle must be built **on a Windows x64 computer**, because it needs the Windows build
of `better-sqlite3`. See [windows-gateway.md](windows-gateway.md#build-the-windows-bundle).

## Before you push

- `npm run check` passes.
- Docs that describe what you changed are updated in the same commit.
- No patient data, `config.json`, database or `.dcm` file is in the commit.
