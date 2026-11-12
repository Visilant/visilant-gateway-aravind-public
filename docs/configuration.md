# Gateway configuration

The service and user CLI read `config.json` by default. `GATEWAY_CONFIG` selects another
file. Startup validates required fields, rejects unknown keys, and fails on invalid
configuration. Paths resolve relative to the process working directory.

[`config.example.json`](../config.example.json) is a hospital/Windows template whose
paths, hosts, AE titles, centre code, and procedure ID need site-specific values. For
local development, copy it to `config.json` and point `mwl` and `store` at the Compose
archive: both `localhost:11112`, with called AE `WORKLIST` for `mwl` and `DCM4CHEE` for
`store`. Remove `mwl.requested_procedure_id` (the example `REPLACE_ME` matches nothing)
and use `"scheduled_station_ae": "VISILANT"`. See [development.md](development.md#2-first-run-from-source).

## Settings

| Key | Default / purpose |
| --- | --- |
| `centre_code` | Required; identifies the centre in authentication tokens. |
| `listen_port` | `8080` |
| `storage_root` | Required; local DICOM storage directory. |
| `database_path` | Required; gateway SQLite file. |
| `retention` | `KEEP` (default) retains the newest `retention_keep_count` sent files and prunes older ones; `DELETE_ON_SENT` removes each file once the PACS acknowledges it. |
| `retention_keep_count` | `10`; positive integer, used only under `KEEP`. |
| `study_uid_root` | Required; UID root used for derived study/series/SOP identifiers. |
| `sync_interval_seconds` | `30`; gateway queue worker interval. |
| `send_immediately` | `true`; trigger delivery when a capture is accepted. |
| `max_send_attempts` | `20`; park unsuccessful deliveries as `FAILED` after this many attempts. |
| `screening_expiry_days` | `7`; release a screening that cannot finish (images missing or a capture `FAILED`) after this many days with no activity, so its order returns to the worklist. Nothing is deleted. `0` disables expiry. |
| `mwl` | Required DICOM worklist connection. |
| `store` | Required DICOM archive connection. |
| `telemetry` | Optional; off when absent. See [Telemetry](#telemetry). |

Each DICOM connection requires `host`, positive integer `port`, `called_ae` (the remote
AE), and `calling_ae` (this gateway). AE titles are limited to 16 characters.
Keep worklist and archive connections separate even when they share a host.

Optional worklist matching keys. Set at least one; with none the gateway logs an
unfiltered-worklist warning at start-up. How to choose: [worklist.md](worklist.md#the-three-filters).

- `requested_procedure_id`: Requested Procedure ID (0040,1001), when the HIS uses one fixed code for this exam type.
- `modality`: Modality (0008,0060) in the scheduled step, for example `OP`; omit to match any modality.
- `scheduled_station_ae`: Scheduled Station AE Title (0040,0001); limits results to orders scheduled for this device.

## Telemetry

Phone and gateway telemetry, kept in SQLite and pushed to the central store. What it
records and how the push works: [telemetry.md](telemetry.md).

| Key | Default / purpose |
| --- | --- |
| `telemetry.enabled` | `false`. Off: `POST /telemetry/events` answers 204 and stores nothing, the gateway writes no events of its own, and nothing is pushed. |
| `telemetry.site_id` | Required when `enabled` is `true`: the vision centre ID, 1 to 64 letters, digits, `_` or `-`. Every record carries it. The gateway will not start with telemetry on and no `site_id`. |
| `telemetry.central_url` | The central receiver, `http` or `https`, without `/v1/telemetry/batch`. Set it together with `central_token`. Without both, nothing is pushed and rows wait in the outbox. |
| `telemetry.central_token` | This gateway's bearer token for central. Shown as `(set)` by `GET /system/config`. |
| `telemetry.max_outbox_mb` | `200`. Above this, sent rows are deleted oldest first. Unsent rows are never deleted; if they alone pass it, new `device.health` events are dropped. |
| `telemetry.retention_days` | `90`. Sent rows older than this are deleted. |

The `gateway_id` that tells apart two gateways at one site is generated, not configured:
it is kept in the database (`setting` key `telemetry.gateway_id`).

## Change worklist filters in the dashboard

An administrator can open **Diagnostics → Explain this worklist** at `/ui`, edit the
station AE, procedure ID and modality, and **Preview these filters** before saving.
Empty fields remove filters. The dashboard accepts printable ASCII values up to 16
characters and trims surrounding spaces. A preview never changes the saved settings.

**Save filters** takes effect on subsequent worklist requests, without restarting the
gateway. It persists all three fields together in SQLite as `worklist.filters.v1`.
These values override the three filters from `config.json` at startup; `/system/config`
shows the effective configuration. Other settings still come from the config file.
**Restore config-file filters** removes the override and uses the file values loaded at
startup. To pick up later edits to that file, restart the gateway as well.

Two dashboard sessions cannot overwrite each other's changes silently: a stale save
returns 409 and must be reloaded. A failed database write leaves the active settings
unchanged. Damaged saved filters stop startup rather than silently broadening the worklist.
Only administrators can preview alternative filters, save them or reset them. Operators
can inspect results and check the current filters.

These controls change matching keys. They do not supply a missing Accession Number or
map a patient identifier into an order identifier. An alternate order-ID mapping requires
AEH to confirm the exact input tag and its unique-per-order meaning first.

## Environment

| Variable | Purpose |
| --- | --- |
| `GATEWAY_CONFIG` | Config file path; service and user CLI. |
| `DATABASE_PATH` | Migration CLI database path; default `data/gateway.db`. Does not override service config. |
| `LOG_LEVEL` | Logger level; default `info`. |
| `IMG2DCM_BIN`, `DCM2JSON_BIN`, `ECHOSCU_BIN`, `FINDSCU_BIN`, `STORESCU_BIN`, `DCMDUMP_BIN`, `DCMODIFY_BIN` | DCMTK executable overrides; otherwise resolved on PATH. |
| `MAGICK_BIN` | ImageMagick executable override; otherwise `magick` on PATH. |
| `GATEWAY_DIAGNOSTICS_DIR` | Force gateway diagnostics on, in the selected directory. The operator page cannot turn it off. |
| `GATEWAY_LOG_DIR` | Write log files here as well as the console. Unset means console only. |
| `GATEWAY_SETUP_DIR` | Setup wizard data folder. `windows/run.ps1` sets it to `%ProgramData%\Visilant`; elsewhere the default is `data/setup`. |

## Accounts and secrets

Create operators with `npm run users -- add <email> <username>`; add `--admin` for an
administrator. Omitting `--password` generates a password and prints it once. Use
`npm run users -- passwd <email>` to reset it. The gateway keeps accounts locally.

JWT signing secrets are generated on first use and stored in SQLite. They persist
across restarts. Include the database when backing up gateway state; queued DICOM
files and the database must be kept consistent. Do not distribute shared signing secrets.

Patient data and credentials must never enter git, the database or the logs; see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md). Read [dicom-output.md](dicom-output.md#retention) before changing retention.
