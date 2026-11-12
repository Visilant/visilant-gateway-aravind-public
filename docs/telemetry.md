# Telemetry

The gateway collects telemetry from the phones at its centre and about itself, keeps it
in SQLite, and pushes it to one central store. Records from every centre use the same
envelope and the same `event_id`, so central combines all sites with a plain union and
no per-site handling.

Telemetry is **off** unless `telemetry.enabled` is `true`. While it is off,
`POST /telemetry/events` answers 204 and stores nothing, the gateway writes none of its
own events, and nothing is pushed.

```
phone ──POST /telemetry/events──▶ gateway ──SQLite telemetry_event (outbox)──▶ push worker ──POST /v1/telemetry/batch──▶ central
```

The phone stores nothing. It sends each event when it happens and then forgets it. While
it cannot reach the gateway it keeps only a note in memory (since when, how many events
it dropped), and sends that note as one `gateway.unreachable` event when it reconnects.

## Turning it on at a centre

1. Install a gateway with this code. Telemetry stays off.
2. Add a `telemetry` block to `config.json` ([configuration.md](configuration.md#telemetry)):

   ```json
   "telemetry": {
     "enabled": true,
     "site_id": "VC-THENI-01",
     "central_url": "https://central.example.org",
     "central_token": "<this gateway's token from central>"
   }
   ```

   `site_id` is the vision centre ID. With `enabled: true` and no `site_id` the gateway
   refuses to start and names the key.
3. Restart the gateway. The log shows `telemetry push started, every 60s`.
4. Check that this gateway's `gateway.heartbeat` events arrive at central.

Without `central_url` and `central_token`, the outbox fills and nothing is pushed. Rows
can still be taken off the gateway with the [export](#export-for-a-site-that-stays-offline).

## The envelope

Every event has the same fields: on the wire from the phone (without the three fields the
gateway sets), in SQLite, in the push to central and in the export.

| Field | Type | Set by | Meaning |
| --- | --- | --- | --- |
| `event_id` | UUIDv7, lowercase | Producer | Global key. The gateway and central both ignore an `event_id` they already hold. Time-ordered. |
| `schema_version` | integer | Producer | Version of the payload. `1`. |
| `type` | string | Producer | One of the types below. |
| `occurred_at` | ISO 8601 UTC | Producer | Phone or gateway clock at the event. |
| `received_at` | ISO 8601 UTC | Gateway | Gateway clock on receipt. Central uses it to correct phone clock skew. |
| `site_id` | string | Gateway config | `telemetry.site_id`. |
| `gateway_id` | UUID | Gateway | Generated once and kept in the `setting` table (`telemetry.gateway_id`), so it survives a reinstall that keeps the database. Tells apart two gateways at one site. |
| `device_id` | UUID or null | Phone | Generated once per app install. Null for gateway events. |
| `session_id` | UUID or null | Phone | One app launch. Null for gateway events. |
| `capture_id` | string or null | Producer | The phone's capture ID (its `Idempotency-Key`). Joins to the image at the site. |
| `screening_id` | string or null | Producer | Joins to the screening at the site. |
| `authenticated` | boolean or null | Gateway | `true` when the phone's request carried a valid token, `false` when it did not. Null for the gateway's own events. |
| `payload` | object | Producer | The type's own fields. Stored as JSON text. |

The SQLite table `telemetry_event` also has outbox bookkeeping that never leaves the
gateway: `seq`, the order rows were written (an `AUTOINCREMENT` key, never reused);
`sent_at`, set when central confirms the row; and `push_attempts`, `quarantined_at` and
`quarantine_reason` (see [Push to central](#push-to-central)). Clocks on phones and on
this computer can be wrong, so the push, the export cursor and unclean-shutdown
detection all follow `seq`, never a timestamp or `event_id`.

## Before sign-in

A phone may send telemetry without a token, so a crash or a health sample on the
sign-in screen is not lost. Because anyone on the centre's network can then write to
the route, an unsigned request is limited:

- Only `app.started`, `app.crashed`, `operation.failed`, `device.health` and
  `gateway.unreachable` are taken. A batch with any other type is refused whole with 401
  (`<type> needs a signed-in phone`), and nothing from it is stored.
- At most 32 KB a request and 8 KB an event (413 beyond either). A pre-sign-in crash
  with more stack frames than fit must send fewer.
- At most 30 requests a minute per client IP, and 120 a minute from all unsigned
  clients together, so rotating addresses do not get around it. Beyond either the answer
  is 429 with `Retry-After`. Rejected and invalid requests count too. The counts are in
  memory and a restart clears them.
- Each row is stored with `authenticated: false`, so central can tell these rows apart
  and weigh them accordingly.

An expired or invalid token is treated as no token. A signed-in request may send every
phone type, is not rate-limited, and may carry events of up to 32 KB each. These checks
are `TelemetryAccess`, a middleware on the route; the type rule and the event sizes are
in `TelemetryService`. Unsigned rows also count first against the
[outbox caps](#outbox-size).

## Event types

### Sent by the phone

`device_id` and `session_id` are required. `capture_id` is required on the three
`capture.*` types. The types marked *sign-in* need a signed-in request; the rest may be
sent [before sign-in](#before-sign-in).

| Type | When | Payload |
| --- | --- | --- |
| `app.started` | App launch | `app_version`, `android_version`, `device_model`; optional `android_sdk`, `ai_model_revision`, `ai_model_manifest_sha256`, `yolo_model_revision` |
| `app.crashed` | At the crash, best effort (`source: "uncaught_handler"`), or at the next launch from Android's `ApplicationExitInfo` (`source: "exit_info"`) | `source`, `app_version`; optional `error_code`, `exception_class`, `exit_reason`, `crashed_session_id`, `stack_frames` (up to 64 of `{ class, method, file, line }`, `file` a `.kt` or `.java` source) |
| `operation.failed` | A handled error the operator sees | `operation`, `error_code` |
| `capture.taken` (*sign-in*) | Photo accepted for upload | `light` (`WHITE`, `BLUE`, `SLIT`), `eye` (`L`, `R`), `mode` (`autocapture`, `manual`) |
| `capture.uploaded` (*sign-in*) | Upload finished | `duration_ms`, `bytes`, `http_status` |
| `capture.upload_failed` (*sign-in*) | Upload gave up | `duration_ms`; optional `bytes`, `http_status`, `error_code` |
| `yolo.autocapture` (*sign-in*) | An autocapture attempt ends | `outcome` (`fired`, `timed_out`, `cancelled`), `frames_evaluated`, `rejected_frames` (counts by `no_eye`, `clipped`, `too_close`, `too_far`, `off_centre`, `no_iris`, `gaze_off`, `hold_broken`), `yolo_model_revision`; optional `time_to_trigger_ms`, `winning_box` (`x`, `y`, `width`, `height`, each 0 to 1 of the frame), `winning_score` (0 to 1), `operator_decision` (`kept`, `retook`) |
| `device.health` | Every 5 min while the app is in front | `battery_pct`, `charging`, `free_storage_bytes`, `network_kind` (`wifi`, `cellular`, `ethernet`, `none`, `other`), `seeker_connected`; optional `battery_temp_c`, `thermal_status` (Android thermal status, lowercase), `wifi_rssi_dbm` |
| `gateway.unreachable` | First successful send after an outage | `from`, `to` (ISO 8601 UTC), `dropped` (counts by phone event type) |

Text fields accept only versions (`[A-Za-z0-9._+-]`, up to 64), error and operation
codes (`[A-Za-z0-9_.-]`, up to 64), Java class and method names, SHA-256 hex, and the
device model. There is no free-text field. The exact rules are in
[`telemetry.dto.ts`](../src/application/dto/telemetry.dto.ts).

### Written by the gateway

The phone may not send these types.

| Type | When | Payload |
| --- | --- | --- |
| `gateway.started` | Start-up | `gateway_version`, `uptime_s`, `outbox_backlog` (unsent rows) |
| `gateway.heartbeat` | Every 60 s | Same as `gateway.started` |
| `gateway.stopped` | Clean shutdown | Same as `gateway.started` |
| `gateway.unclean_shutdown` | Start-up, when the last of the three rows above to be written is not `gateway.stopped` | `last_heartbeat_at`, `restarted_at`, `downtime_s` |
| `ai.assessed` | `POST /captures` with a valid `ai_assessment` | `gateway_capture_id`, `laterality`, `light`, `assessment` (the `AiAssessment` as received). `capture_id` is the phone's `Idempotency-Key`, or the gateway's capture ID when there was none. |

A power cut in the first minute leaves `gateway.started` as the last row written, so that is
also reported as an unclean shutdown. `last_heartbeat_at` is then the start time.

## Push to central

`TelemetryPushWorker` runs every 60 s, and right away when 500 or more rows are unsent.

1. Read up to 500 rows with `sent_at IS NULL` that are not quarantined, in the order
   they were written.
2. `POST <central_url>/v1/telemetry/batch` with `Authorization: Bearer <central_token>` and
   body `{ "events": [ <envelope>, ... ] }`. The envelope has the payload as an object
   and no `sent_at`. A path in `central_url` is kept: `https://host/ingest` posts to
   `https://host/ingest/v1/telemetry/batch`.
3. Central inserts each event with `ON CONFLICT (event_id) DO NOTHING` and answers 200
   with `{ "event_ids": [ ... ] }`: every `event_id` of the batch that it now holds,
   including those it already had.
4. The gateway sets `sent_at` on the returned ids that were in the batch, in one UPDATE.
   Ids it did not send are ignored.
5. A full batch goes round again until fewer than 500 rows were read.

One bad row cannot stall the outbox:

- **400, 413 or 422** blames the request, so the batch is halved and each half sent
  again, down to single rows. A row central refuses on its own is **quarantined** with
  `quarantine_reason` `central_400`, `central_413` or `central_422`.
- A row central leaves out of 5 answers is quarantined with `unconfirmed`. Each answer
  that leaves it out adds 1 to `push_attempts`.
- A quarantined row is never pushed again and never pruned. It is listed in the
  [export](#export-for-a-site-that-stays-offline) with its `quarantine_reason`, and the
  log says how many were quarantined. Nothing about the row's content is logged.

Any other answer is a failure of the whole batch: another non-2xx status, a network
error, a 30 s timeout, a body without an `event_ids` list of strings, or a reply that
confirms and quarantines nothing. The rows stay unsent, and the log says
`telemetry push failed: ...` with the HTTP status or the network error code and what to
check: the token for 401 and 403, nothing on site for 5xx. The next attempt waits 1, 2,
4, 8, 16 and then 30 minutes, timed on a monotonic clock so a wall clock set back cannot
stall it. The first success resets the wait. The wait is not kept across a restart.

A power cut between central's reply and step 4 only means the rows are sent again, and
central ignores them.

## Outbox size

`TelemetryOutbox` bounds the outbox without deleting anything central has not
confirmed, and decides what may still be written.

**Pruning**, at start-up and every 10 minutes:

- Sent rows with `occurred_at` older than `telemetry.retention_days` (90) are deleted.
- While the database file holds more than `telemetry.max_outbox_mb` (200) in live pages,
  sent rows are deleted oldest first. The size is the file's real size (`page_count`
  minus `freelist_count`, times `page_size`), so captures' own rows count towards it too;
  they are small.
- The freed pages are given back to the disk with `PRAGMA incremental_vacuum`. A
  database created before this release is switched to incremental vacuum once, at
  start-up, with one `VACUUM`; that is skipped (and retried at the next start) when the
  disk lacks twice the file's size plus 1 GB free.
- **Unsent rows are never deleted**, quarantined ones included.

**What is still written** depends on the unsent rows' estimated size (their text plus
200 bytes a row). It is kept as a running total as rows are written and confirmed, read
from the table at start-up and checked against it once a day, so no request counts the
table.

| Unsent rows | Stored | Refused (their ids come back in `dropped`) |
| --- | --- | --- |
| Up to `max_outbox_mb` (200) | Everything | Nothing |
| Over `max_outbox_mb` | Signed-in crash, capture, YOLO and operation events; `ai.assessed`; the gateway lifecycle | Everything sent without sign-in; `device.health` |
| Over `max_unsent_mb` (400) | The gateway lifecycle (`gateway.*`) only | Every phone event; `ai.assessed` |

Each step up is logged once as an error, and the way back down once as info.

**Free disk.** Every minute the gateway checks the free space on the disks of the
database and of `storage_root`. Below `telemetry.min_free_disk_mb` (1024) nothing at all
is stored, lifecycle rows included, so captures always have room. This is logged once,
and again when space returns.

So the unsigned path can add at most about `max_outbox_mb` of unsent rows, and phones
together at most about `max_unsent_mb`; the lifecycle adds about 0.5 MB a day after that.
Central's offline alert (no heartbeat for 24 h) should fire long before either cap.

## Export for a site that stays offline

`GET /telemetry/export?since=<event_id>` (ADMIN) streams the unsent rows written after
the event `since` (or all of them) as NDJSON, one envelope per line, in the order they
were written. A phone with a slow clock makes event_ids that sort earlier, so `since`
follows write order, not the id. A `since` this outbox does not hold (for example one
already sent and pruned) is 400: omit it for a full export. The file is
named `telemetry-<site_id>-<UTC time>.ndjson`. A quarantined row's line also has
`quarantine_reason`; central's import should ignore that field. A support person uploads it to central,
which ingests it through the same dedup. When the internet returns, the normal push
sends the same rows, central returns their ids, and only then are they marked sent.
Exporting marks nothing.

## Patient data

Records are pseudonymous, not anonymous: `capture_id` and `screening_id` join to a
patient's `.dcm` at the site, on purpose. Patient identity never enters a record.

- Every type is an allow-list DTO with `whitelist` and `forbidNonWhitelisted`. Unknown
  types and keys are 400. There is no message field.
- Crashes carry the exception class, an error code and code-only frames. The exception
  message is never sent.
- `ai.assessed` carries the assessment, never the worklist entry.
- A rejected value is never returned and never logged, and neither is a key name the
  client sent: an unknown key is `<unknown key>`. The log line is
  `telemetry rejected: event <index> (<type>) <field path> <reason>`, and the type is
  logged only when it is one of the types above.
- A body that is not valid JSON is answered with a fixed message; the parser's message,
  which quotes the body, is not logged.

## Where the code is

| Path | Does |
| --- | --- |
| `src/application/dto/telemetry.dto.ts` | Envelope and payload rules per type, limits |
| `src/presentation/controllers/telemetry.controller.ts` | `POST /telemetry/events`, `GET /telemetry/export` |
| `src/presentation/telemetry-limits.ts` | 256 KB and 100-event limits (413) |
| `src/presentation/middlewares/telemetry-access.middleware.ts` | Telemetry off (204), the optional token, limits for unsigned requests (413, 429) |
| `src/presentation/rate-limiter.ts` | The fixed-window counter those limits use |
| `src/application/services/TelemetryService.ts` | Writes phone and gateway events, `gateway_id`, export |
| `src/application/services/TelemetryLifecycle.ts` | Started, heartbeat, stopped, unclean shutdown |
| `src/application/services/TelemetryPushWorker.ts` | Push to central with backoff |
| `src/application/services/TelemetryOutbox.ts` | Pruning and the `device.health` stop |
| `src/infrastructure/telemetry/CentralClient.ts` | The HTTP call to central |
| `src/infrastructure/database/repositories/TelemetryRepository.ts` | The `telemetry_event` table |
