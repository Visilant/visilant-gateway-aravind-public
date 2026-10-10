# Gateway configuration

The service and user CLI read `config.json` by default. `GATEWAY_CONFIG` selects another
file. Startup validates required fields, rejects unknown keys, and fails on invalid
configuration. Paths resolve relative to the process working directory.

[`config.example.json`](../config.example.json) is a hospital/Windows template whose
paths, hosts, AE titles, centre code, and procedure ID need site-specific values. For
local development, copy it to `config.json` and point `mwl` and `store` at the Compose
archive: both `localhost:11112`, with called AE `WORKLIST` for `mwl` and `DCM4CHEE` for
`store`. Remove `mwl.requested_procedure_id` (the example `REPLACE_ME` matches nothing)
and use `"scheduled_station_ae": "VISILANT"`. See [development.md](development.md#first-run).

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

Each DICOM connection requires `host`, positive integer `port`, `called_ae` (the remote
AE), and `calling_ae` (this gateway). AE titles are limited to 16 characters.
Keep worklist and archive connections separate even when they share a host.

Optional worklist matching keys. Set at least one; with none the gateway logs an
unfiltered-worklist warning at start-up. How to choose: [worklist.md](worklist.md#the-three-filters).

- `requested_procedure_id`: Requested Procedure ID (0040,1001), when the HIS uses one fixed code for this exam type.
- `modality`: Modality (0008,0060) in the scheduled step, for example `OP`; omit to match any modality.
- `scheduled_station_ae`: Scheduled Station AE Title (0040,0001); limits results to orders scheduled for this device.

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
