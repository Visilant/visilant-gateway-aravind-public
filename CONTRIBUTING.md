# Contributing

Rules for people and coding agents working in this repository. Read this before you change
code. For what the system does, start at [docs/README.md](docs/README.md).

## Commands

Use **Node 22** (`nvm use`). DCMTK and ImageMagick must be on `PATH`. See
[docs/development.md](docs/development.md).

| Task | Command |
|---|---|
| Install | `npm ci` |
| Typecheck | `npm run typecheck` |
| Test | `npm test -- --runInBand` (`TEST_DCMTK=1` adds the real-DCMTK tests) |
| End to end | `npm run e2e` (needs Docker) |
| Build | `npm run build` |
| Everything CI runs | `npm run check` |

## Documentation

- When behaviour, a script or a config key changes, update the document that describes it
  **in the same change**. A document that disagrees with the code is a bug.
- Documents describe the system as it is. Put the reason for a change in the commit
  message or pull request.

## Layering: controller → service → repository

- **Controller** (`@JsonController`). HTTP only: take the validated DTO, call a service,
  return the result. No business logic and no database access. Authorisation is a
  decorator on the route, not an `if` in the handler.
- **Service** (`@Service()`). Owns the business logic and decides what the data layer does.
- **Repository** (`@Service()`). Data access only, one per entity. No business logic.

Dependencies are **injected through the constructor** by type
(`constructor(private readonly x: XService)`), not fetched with `Container.get()`. The
three start-up values (config, logger, database) are injected by token from
`src/tokens.ts`.

If a repository starts to branch on state or role, that logic belongs in the service.

## Database changes: entity first, then generate

1. Change the entity.
2. Generate the migration from the difference. Never write one by hand.
3. Read it. SQLite cannot `ALTER TABLE ADD CONSTRAINT`, so TypeORM rebuilds the table.
   Then check that `migration:generate` reports no changes.
4. Commit the entity and its migration together.

Migrations run at start-up. A migration that cannot run twice, or that loses data, breaks
a centre's gateway with no one on site to fix it.

## The gateway computer is unattended

Assume power cuts in the middle of an operation, a PACS that is away for hours, and nobody
watching.

- Anything that must survive goes in SQLite. Nothing important lives only in memory.
- Recover at start-up instead of assuming a clean shutdown (`SENDING` → `PENDING`).
- Never delete a local file before the archive has confirmed it.
- Error messages are the only diagnosis anyone gets. "exited with code unknown" becomes a
  support call. Say what failed and what to do about it.

## Patient data (PHI)

Patient identity lives inside the `.dcm` files on disk. It must never go into the
database, the logs or Git.

- `img2dcm -k` arguments contain patient data, and `execFile` puts the whole argument list
  into its error message. Log the tool's stderr and exit code only, never `err.message`.
  `DicomClient.run` does this; use it for every tool call.
- Use only made-up test data. Never commit a `config.json`, a database, a `.dcm` file, a log
  or a screenshot from a site.

## Validation

class-validator DTOs check every request at the edge. Config is checked the same way at
start-up, and the process refuses to start if it is wrong.

- **`@ValidateNested()` accepts a missing property.** Always pair it with `@IsDefined()`.
- **Validation errors must never repeat the rejected value.** `validationError: { value: false }`
  is set in `src/presentation/server.ts`, because a failing field here is a patient name.
- `whitelist` and `forbidNonWhitelisted` are on, so an unknown or misspelt key is an error,
  not a setting that silently does nothing.

## Contract with the capture app

The capture app is not in this repository, but it depends on the HTTP API
([docs/api.md](docs/api.md)) and on the AI result format (`src/domain/assessment.ts`).

- The gateway rejects unknown keys. A new field that the phone sends must first be added
  to the gateway, as optional, and deployed before any phone sends it.
- Do not remove or rename a field that phones already send or read.
