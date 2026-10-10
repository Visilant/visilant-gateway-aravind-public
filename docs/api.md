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
| `GET` | `/system/config` | Effective config and runtime metadata; no signing secrets. |
| `GET` | `/system/device` | Current process and storage sample plus the last 12 samples at five-second intervals. |

Failed captures also degrade `/health` and need operator attention. The app upload queue
and the gateway delivery queue are separate; see [architecture.md](architecture.md).

## DICOM output

Captures use Ophthalmic Photography 8 Bit (`1.2.840.10008.5.1.4.1.1.77.1.5.1`), modality
`OP`, and JPEG Baseline. The builder honors a worklist Study Instance UID and derives
one from the accession when absent. Eye/light combinations get separate series.
Missing demographics stay empty. AI findings use the documented Visilant private
creator and JSON element; PACS preservation needs integration verification.

Source contracts: [DTOs](../src/application/dto/) and
[controllers](../src/presentation/controllers/). Full DICOM details are in
[dicom-output.md](dicom-output.md).
