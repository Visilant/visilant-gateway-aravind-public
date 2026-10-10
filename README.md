# Visilant Gateway

The Visilant Gateway is a small on-premises service that connects the Visilant eye-capture
app to a hospital's DICOM systems. It runs on one Windows computer inside the hospital
network and needs no internet connection.

It does three things:

1. **Reads the worklist.** It asks the hospital's DICOM Modality Worklist (MWL) server which
   patients are scheduled, using a DICOM C-FIND query, and gives that list to the phone.
2. **Receives photographs.** The phone uploads each eye photograph with the worklist order it
   belongs to. The gateway turns the JPEG into a DICOM Ophthalmic Photography object at once
   and saves it to local disk.
3. **Sends to the PACS.** A background worker sends each DICOM file to the hospital archive
   (PACS) with C-STORE. It retries with back-off, and after `max_send_attempts` failures it
   marks the photograph `FAILED` for an operator to retry.

```mermaid
flowchart LR
    phone["Capture app<br/>(Android phone)"]
    subgraph box["Gateway computer (Windows)"]
        gw["Visilant Gateway<br/>HTTP :8080"]
        db[("SQLite<br/>queue + accounts")]
        disk[("captures/<br/>.dcm files")]
    end
    mwl["Worklist server<br/>(MWL, C-FIND)"]
    pacs["Image archive<br/>(PACS, C-STORE)"]

    phone -- "sign in, worklist, upload JPEG" --> gw
    gw -- "C-FIND" --> mwl
    gw --> db
    gw --> disk
    gw -- "C-STORE (retries)" --> pacs
```

This repository holds **only the gateway**. The capture app and its AI models are not
included. The gateway accepts an optional AI result that the app sends with a photograph,
checks its format and stores it in a private DICOM tag. It does not run any model.

## Start here

| If you want to... | Read |
|---|---|
| Understand how the code is organised | [docs/architecture.md](docs/architecture.md) |
| Change how the worklist is queried or filtered (procedure ID, modality, station) | [docs/worklist.md](docs/worklist.md) |
| Change what goes into the DICOM file or how it reaches the PACS | [docs/dicom-output.md](docs/dicom-output.md) |
| Run the gateway on your computer, run tests, make a change | [docs/development.md](docs/development.md) |
| Install it on a Windows computer at a hospital | [docs/windows-gateway.md](docs/windows-gateway.md) |
| See every `config.json` setting | [docs/configuration.md](docs/configuration.md) |
| See the HTTP API that the phone uses | [docs/api.md](docs/api.md) |
| Fix a problem at a site | [docs/troubleshooting.md](docs/troubleshooting.md) |
| See how the Aravind installation is set up | [docs/aravind-deployment.md](docs/aravind-deployment.md) |
| Follow the coding rules for this repository | [CONTRIBUTING.md](CONTRIBUTING.md) |

All documents are listed in [docs/README.md](docs/README.md).

## Quick start (macOS or Linux)

You need **Node 22**, **DCMTK**, **ImageMagick** and **Docker**. See
[docs/development.md](docs/development.md) for details.

```bash
nvm use                                                   # Node 22, pinned in .nvmrc
npm ci
docker compose -f dev/docker-compose.pacs.yml up -d      # local test PACS + worklist (dcm4chee)
cp config.example.json config.json                       # then edit: see below
npm run users -- add you@example.org you --admin         # prints a generated password once
npm run dev
curl -s localhost:8080/health
```

For the local test PACS, set `mwl` and `store` in `config.json` to host `localhost`, port
`11112`. The worklist `called_ae` is `WORKLIST` and the archive `called_ae` is `DCM4CHEE`.
In `mwl`, **remove** `requested_procedure_id` (the example value `REPLACE_ME` matches
nothing) and add `"scheduled_station_ae": "VISILANT"`. Set `storage_root` and
`database_path` to local paths (for example `captures` and `data/gateway.db`). The full
file is in [docs/development.md](docs/development.md#first-run). Add test patients to the
worklist with `node dev/seed-mwl.mjs 5`.

`GET /health` checks the database, the queue, free disk space, and sends a DICOM C-ECHO to
both servers. It returns `200` when everything works and `503` when something does not,
with a `detail` on the check that failed.

To test the whole path (worklist, upload, DICOM, PACS) against the local archive, run
`npm run e2e`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the gateway from source |
| `npm run build` then `npm start` | Compile to `build/` and run the compiled gateway |
| `npm run typecheck` | Type-check without building |
| `npm test -- --runInBand` | Unit and integration tests (`TEST_DCMTK=1` also runs the tests that call real DCMTK) |
| `npm run e2e` | End-to-end test against the local PACS |
| `npm run check` | Typecheck, test and build: run this before you push |
| `npm run users -- add <email> <username> [--admin]` | Create an account (prints a generated password once) |
| `npm run users -- passwd <email>` | Reset a password |
| `npm run migration:generate -- migrations/Name` | Generate a database migration from an entity change |
| `npm run setup` | Run the setup wizard and gateway supervisor (used by the Windows bundle) |

## Technology

TypeScript on Node 22. HTTP with routing-controllers and Express, dependency injection with
TypeDI, validation with class-validator, database with TypeORM over SQLite
(better-sqlite3). The DICOM work is done by the DCMTK command-line tools (`findscu`,
`img2dcm`, `storescu`, `echoscu`, `dcm2json`, `dcmdump`, `dcmodify`) and ImageMagick
(`magick`).

## Patient data

The worklist, the uploaded photographs and the `.dcm` files contain patient data. Patient
data stays in the `.dcm` files on disk. It must never go into the database, the logs or Git.
`config.json`, `data/` and `captures/` are runtime files and are ignored by Git. See
[CONTRIBUTING.md](CONTRIBUTING.md#patient-data-phi).

## License

[MIT](LICENSE) © 2026 Visilant
