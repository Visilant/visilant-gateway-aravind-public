# Gateway HTTP API

The local app talks to the gateway over HTTP. All endpoints except `/health`, `/signin`,
`/refresh` and the static operator page `/ui` require `Authorization: Bearer <token>`.
`/setup-progress` is used only by the setup wizard on the same computer and takes a
loopback-only `x-setup-token` instead. Successful application responses
are wrapped in `{ "data": ... }`. `/health` returns a flat monitoring response.

## Authentication and worklist

| Method | Path | Input / result |
| --- | --- | --- |
| `POST` | `/signin` | JSON `{ email, password }`; returns `{ token, refresh_token, user }`. |
| `POST` | `/refresh` | JSON `{ refresh_token }`; returns a new token pair. |
| `GET` | `/health` | Database, queue, disk, and C-ECHO checks; 200 healthy, 503 degraded. |
| `GET` | `/worklist` | Live C-FIND; optional `date`, `patient_id`, `accession_number` query keys. Config adds procedure/modality/station filters; see [worklist.md](worklist.md). |

Worklist names and dates remain DICOM-native (`FAMILY^GIVEN`, `YYYYMMDD`). The app formats
them for display. Send the original worklist object with the capture: a RIS can remove
an order before an offline capture's later delivery. Send the row exactly as received:
the read-only fields the gateway adds (`source_scope`, `submission`) are accepted and
ignored on upload, and every other unknown key is still rejected with 400.

## Capture upload

`POST /captures` accepts multipart form data:

| Part | Required | Meaning |
| --- | --- | --- |
| `file` | Yes | JPEG, with `image/jpeg` part content type. |
| `worklist_entry` | Yes | JSON string containing the original worklist entry. |
| `laterality` | Yes | `L` or `R`. |
| `light` | No | `WHITE`, `BLUE`, or `SLIT`; omit when unknown. |
| `pupil_dilated` | No | `YES` or `NO`. |
| `series_description` | No | DICOM series description. |
| `screening_id` | For manifested submissions | Registered screening ID (same format as the manifest `id`). The `Idempotency-Key` must be one of its declared capture IDs, and the entry's accession, Study UID and scheduled step must match the manifest's order exactly. The echoed `worklist_entry.source_scope` is ignored. |
| `ai_assessment` | No | Valid assessment JSON; permitted only with `light=WHITE`. |

Send a stable `Idempotency-Key` header for each capture. Repeating it returns the
existing capture and avoids another delivery. The replay is answered before any screening
validation, so a retry of an accepted capture never gets a 400. The Android queue uses its durable row
ID for this key. See [dicom-output.md](dicom-output.md#ai-result-private-tag) for assessment validation.

The response includes the capture ID, status, study/series/SOP Instance UIDs, and
accession number. Acceptance means the gateway has stored the DICOM file and queue
row. PACS delivery can happen later.

## Screening delivery and active worklist

All screening routes require the same authenticated active local operator as captures;
there is no additional role policy in this evaluation build. Responses use `{ "data": ... }`.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/screenings/capabilities` | `{ screening_delivery: 1, screening_release: 1, source_scope }` |
| `POST` | `/screenings` | Register an immutable manifest, return its delivery status. |
| `GET` | `/screenings/:id` | Status of any registered manifest, whatever scope it was registered under; 404 only for an unknown ID. |
| `GET` | `/screenings` | Current-scope delivery records, including completed records for shared phone recovery. Released records are left out unless `?view=all`; `?view=unfinished` returns everything not completed across every scope (for the operator page). Released records are listed for 30 days after release. |
| `POST` | `/screenings/:id/release` | Release a screening that cannot finish. Body `{ "reason": "PHONE_LOST" \| "CAPTURE_REJECTED" \| "RESHOOT" \| "OTHER" }`. |

Registration body (synthetic example):

```json
{
  "id": "screening-1",
  "source_scope": "<64-character hash from the worklist/capability>",
  "order": { "accession_number": "SYNTHETIC-1", "study_instance_uid": "1.2.3", "step_id": "STEP-1" },
  "capture_ids": ["capture-1", "capture-2"]
}
```

IDs are 1–128 ASCII letters, digits or hyphens. Membership is a nonempty unique set
of at most 1000 capture IDs. `accession_number` and `step_id` are at most 16 characters
(DICOM SH, the same bound as the worklist entry); `study_instance_uid` is at most 64,
numeric and dot-separated. `source_scope` is exactly 64 lowercase hex characters.
Omitted or null `step_id` means explicitly absent.
An identical manifest retry returns 200, including reordered membership, and is judged
against the scope the manifest was registered under — it still succeeds after a scope
change. Changed identity/membership, another screening for the same exact order, an
already-reserved capture ID, or a **new** manifest whose `source_scope` is not the
current one returns 409. Invalid or unknown JSON fields return 400.
Conflicting registration cannot overwrite either submission's files or membership.

Status includes `id`, `source_scope`, `order`, `state`, `created_at`, `last_activity_at`,
`completed_at`, `released_at`, `released_by`, `release_reason`, and `captures`.
Each capture has its declared `capture_id`, nullable `gateway_capture_id`, and
`MISSING`, `PENDING`, `SENDING`, `FAILED`, or `SENT` status. Screening states are
`UPLOAD_PENDING`, `AWAITING_PACS`, `NEEDS_ATTENTION`, `COMPLETED`, and `RELEASED`. Only confirmed
C-STORE success for **every declared capture** can produce `COMPLETED`; clients cannot
write delivery status. Gateway HTTP acceptance never establishes completion.

`GET /worklist` still returns an array. Rows now include `source_scope` and an optional
`submission` status (both read-only; see capture upload). Completed orders are durably
excluded even if C-FIND continues returning them. Multiple scheduled steps are separate
rows. Identity is the exact scope, accession, Study UID and scheduled step (absence is
not a wildcard).

### Source scope

`source_scope` is a SHA-256 over the configured `centre_code` and the worklist's
`mwl.called_ae` — the hospital order namespace, not its network address. Changing the
MWL host or port (a DHCP lease, a moved server) or this gateway's `mwl.calling_ae` does
**not** change the scope. Changing `centre_code` or `mwl.called_ae` does: completion
records from the old scope stop filtering the worklist, and new registrations must use
the new scope.

A scope change never strands work already registered. A manifest keeps the scope it
was registered under: its registration retries return 200, its captures upload and are
validated against its own order, `GET /screenings/:id` keeps reporting it, and PACS
delivery continues. Only a screening that was never registered before the change is
refused (409 `Worklist source changed`); the phone must refresh the worklist and submit
against the new scope. Old-scope manifests no longer appear in `GET /screenings`.

Why not keep host/port in the scope: they identify where the worklist is served from,
not which orders exist, and they change for reasons nobody on site controls.

Legacy captures without `screening_id` remain accepted but cannot complete an order.
A newer phone treats **only capability endpoint 404** as an older gateway: it uploads
with the legacy contract and explicitly says delivery tracking/removal are unavailable.
Such fallback receipts remain unsupported after a gateway upgrade; do not guess legacy
membership. Other capability/status/storage failures retain queued images and the last
confirmed display. Upgrade the gateway before submitting new screenings to enable removal.
Additional imaging needs a distinct order or procedure step, or the release below.

### Releasing a screening that cannot finish

A screening whose images will never all arrive (a lost phone) or never all deliver (a
capture PACS refuses) is **released**. Any signed-in user can release one from the
**Screenings** page or `POST /screenings/:id/release`. The record records who did it and why.

- The row is kept for audit, with `released_at`, `released_by` (a user ID, or
  `system:expiry`) and `release_reason`. Release never sets `completed_at`.
- The order returns to the worklist with no `submission`, and a new manifest for the same
  order registers normally. Captures already accepted keep going to PACS; they do not
  reopen or complete the released screening.
- A capture upload for a released screening returns 409 with a message telling the phone
  to start a new screening. Its images stay on the phone.
- Re-registering a released manifest returns 409 with the same message.
- Releasing a completed screening returns 409. Releasing a released one returns its
  status unchanged. An unknown ID returns 404. A reason outside the list returns 400.
- `RELEASED` is final, like `COMPLETED`.

The gateway also releases a screening on its own (reason `EXPIRED`) when it is
`UPLOAD_PENDING` or `NEEDS_ATTENTION`, no capture is `PENDING` or `SENDING`, and nothing
has happened for `screening_expiry_days` (default 7; `0` turns this off). Activity is
registration, a capture arriving, or an operator retry. A PACS outage that is still
retrying never expires a screening. The check runs at boot and then hourly.

Phones that predate release never see `RELEASED`: they read `GET /screenings` without
`view`. A newer phone asks for `?view=all` only when the capability reports
`screening_release: 1`.
Retrying a `SENT` capture sends it again with the same SOP Instance UID. It does not
reopen a completed screening.

## Telemetry

The phone sends telemetry events to the gateway, which keeps them in its outbox and
pushes them to central. Event types, fields and the push are in
[telemetry.md](telemetry.md).

| Method | Path | Input / result |
| --- | --- | --- |
| `POST` | `/telemetry/events` | Token optional; see below. JSON `{ "events": [ <event>, ... ] }`, 1 to 100 events and at most 256 KB; over either is 413. Returns `{ "data": { "accepted": [...], "duplicate": [...], "dropped": [...] } }`, each a list of `event_id`. With telemetry off: 204, no body, nothing stored. |
| `GET` | `/telemetry/export` | ADMIN. Optional `since=<event_id>`. NDJSON (`application/x-ndjson`) of the unsent rows written after that event, one envelope per line. 400 when `since` is not in the outbox. |

Each event is `{ event_id, schema_version, type, occurred_at, device_id, session_id,
capture_id?, screening_id?, payload }`. `event_id` is a lowercase UUIDv7 made by the
phone. The gateway adds `received_at`, `site_id` and `gateway_id`.

- `accepted`: stored now. `duplicate`: the gateway already had this `event_id` (a retry);
  nothing changed. `dropped`: a `device.health` event not stored because the outbox is
  full of unsent rows. The phone treats all three as delivered and does not resend.
- 400 means the whole request was rejected and nothing from it was stored. `details` is
  a list of `{ event, field, reason }`: the index of the failing event (null for the batch
  itself), the field path in our own names, and `unknown_key`, `missing` or `invalid`. It
  never repeats a value, and an unknown key is shown as `<unknown key>`, never by its name. Unknown types, unknown keys,
  and the gateway's own types (`gateway.*`, `ai.assessed`) are rejected.
- Without a valid token (none, expired or invalid), only `app.started`, `app.crashed`,
  `operation.failed`, `device.health` and `gateway.unreachable` are accepted. Any other
  type refuses the whole request with 401, so sign in and send it again. An unsigned
  request may be at most 32 KB with events of at most 8 KB, and is limited to 30 a
  minute per client IP and 120 a minute from all unsigned clients; beyond those the
  answer is 413 or 429 with `Retry-After`. Signed in, an event may be up to 32 KB. Each
  stored row records `authenticated` true or false.
- A gateway older than this answers 404. The app treats 404 as "telemetry not supported"
  and stops sending for that session.

The gateway writes `ai.assessed` itself when `POST /captures` carries a valid
`ai_assessment`. The phone sends nothing extra for it.

## Queue and delivery

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/captures` | Recent queue records; filter with `status=PENDING`, `SENDING`, `SENT`, or `FAILED`. |
| `POST` | `/captures/sync` | Trigger a gateway queue drain; returns sent/failed counts for that tick. |
| `POST` | `/captures/:id/retry` | Reset a capture to `PENDING`; subsequent worker delivery retries it. |

## Operator page endpoints

The operator page at `/ui` (static, unauthenticated) calls these with the same bearer token.
Responses that expose patient content use `Cache-Control: no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/captures` | Also accepts `study_instance_uid` (numeric DICOM UID, up to 64 characters); rows carry `file_present`. |
| `GET` | `/captures/:id` | Capture row by UUID; omits the server storage key. |
| `GET` | `/captures/:id/preview` | Encapsulated JPEG preview; 404 when the file was removed. |
| `GET` | `/captures/:id/tags` | Curated DICOM tags and validated AI findings. |
| `GET` | `/captures/:id/dicom` | Stream the original DICOM as `<id>.dcm`. |
| `GET` | `/diagnostics` | Recording status and newest-first segments. |
| `PUT` | `/diagnostics/recording` | `{ "enabled": true\|false }`; 409 when `GATEWAY_DIAGNOSTICS_DIR` locks recording. |
| `GET` | `/diagnostics/segments/:id` | Manifest, span and event counts, correlated runs; damaged lines are counted and skipped. |
| `GET` | `/diagnostics/segments/:id/archive` | Stream `<id>.zip` with the segment files. |
| `GET` | `/diagnostics/runs/:runId` | Roll-up across contributing segments and capture references. |
| `GET` | `/system/config` | Effective config and runtime metadata; no signing secrets, and `telemetry.central_token` shows as `(set)`. |
| `GET` | `/system/device` | Current process and storage sample plus the last 12 samples at five-second intervals. |

Failed captures also degrade `/health` and need operator attention. The app upload queue
and the gateway delivery queue are separate; see [architecture.md](architecture.md).

## Worklist diagnostics and filter settings

All routes below require a bearer token and return `Cache-Control: no-store`. ADMIN-only
routes return 403 for an authenticated operator. `/worklist` keeps its existing response
shape. Each HTTP response includes `x-diagnostic-request-id`: the validated incoming UUID
when supplied, otherwise a generated UUID. Explanation check IDs are always generated
independently, so overlapping requests remain distinct.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/diagnostics/worklist` | Schema version 1, safe runtime/build metadata and newest-finished-first history (up to 20 checks in this process). |
| `POST` | `/diagnostics/worklist/check` | Run a gateway-only check using saved filters; no body. |
| `POST` | `/diagnostics/worklist/inspect` | ADMIN; fresh gateway-only query using saved filters; no body. Returns actual incoming records for temporary local inspection. |
| `GET` | `/diagnostics/worklist/settings` | Effective filters, startup file defaults, source, revision and `can_edit`. |
| `POST` | `/diagnostics/worklist/preview` | ADMIN; query with proposed filters without saving. |
| `PUT` | `/diagnostics/worklist/settings` | ADMIN; save all three filters and apply them to future queries. |
| `POST` | `/diagnostics/worklist/settings/reset` | ADMIN; restore startup file filters and remove the persistent override. |
| `GET` | `/diagnostics/worklist/support` | Download the report as `gateway-worklist-support.json` (unenveloped JSON). |

Preview accepts exactly `requested_procedure_id`, `modality`, and `scheduled_station_ae`,
all strings of at most 16 printable ASCII characters. Blank strings mean no filter.
Save/reset also require the 64-character `revision` returned by settings. Save persists
only after validation; 409 means another session changed the settings. Reset ignores the
submitted filter values and restores the startup defaults. The three fields are still
required for a consistent request shape. A concurrent manual check/preview/inspection also returns
409; ordinary worklist requests remain independent.

A check contains `id`, `request_id`, `started_at`, `duration_ms`, `source`, `stage`,
`outcome`, `error_code`, `counts`, boolean `filters`, `recording`, `phone_display` and
`hospital_completion`. Sources distinguish a normal `worklist_request`, `gateway_probe`
and `filter_preview`. Query failures are returned as a failed diagnostic result, not
as an empty successful query; the regular `/worklist` endpoint still fails on these errors.
Counts after a failed stage are partial, with `null` for unavailable file/filtered totals.

On a successful mapping, `candidate_rows = accepted_rows + rejected_rows` and
`accepted_rows = hidden_completed_rows + returned_rows`. Rejections split into
`missing_accession`, `missing_patient_id`, and `missing_both`, counted once per row.
`invalid_json` counts conversion output that could not be parsed as a dataset;
a failing conversion subprocess aborts the query. No field values enter a summary.
For probes, `returned_rows` means rows that would be available, not rows sent to a phone.

Inspection returns `{ check, query, records, parsed_datasets_observed, omitted_records,
omitted_candidate_details, limits }`. `check` is the same sanitized explanation stored
in history. `query` identifies the actual MWL host, port, AE titles and saved filter
values used for this query; no date, patient or accession matching filter is added.
Each record has a one-based `dataset_index`, `dicom_json` (the received dataset after
DCMTK conversion, before gateway normalization) and candidate mapping outcomes.
Candidates identify the one-based scheduled sequence item (`null` for the fallback),
the rejection reason or accepted mapping, and the effective Study UID with its source
(`received`, `derived`, or `not_mapped`). An accepted mapping is not a phone display
or per-row completion observation; the check contains aggregate completion filtering.

The inspection response contains patient data and is ADMIN-only with `no-store`.
It is request-local: records and query values are not retained in the database, recent
history, logs, recorder or support exports. The UI clears them after five minutes,
on explicit clear, refresh, navigation or sign-out. There is no historical raw-record
endpoint. This fresh probe is not the dataset from an earlier phone request.

Inspection is bounded to 100 records, 64 KiB per record, 512 KiB of combined raw JSON
and candidate details, and 1,000 candidate details. Whole records/details are omitted
at a limit and counted explicitly; identifiers in included records are not truncated.
Successful conversions preceding a converter failure remain inspectable, with mapping
unavailable and a failed check. Malformed JSON and binary DICOM responses are not
included; existing conversion failure behavior and temporary-file cleanup are preserved.

## DICOM output

Captures use Ophthalmic Photography 8 Bit (`1.2.840.10008.5.1.4.1.1.77.1.5.1`), modality
`OP`, and JPEG Baseline. The builder honors a worklist Study Instance UID and derives
one from the accession when absent. Eye/light combinations get separate series.
Missing demographics stay empty. AI findings use the documented Visilant private
creator and JSON element; PACS preservation needs integration verification.

Source contracts: [DTOs](../src/application/dto/) and
[controllers](../src/presentation/controllers/). Full DICOM details are in
[dicom-output.md](dicom-output.md).
