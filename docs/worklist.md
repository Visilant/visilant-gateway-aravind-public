# The worklist

This page explains how the gateway gets the list of patients from the hospital, which
DICOM tags it sends and reads, and how to change the filters.

## What a modality worklist is

A hospital information system (HIS) or radiology information system (RIS) creates an
**order** when a doctor requests an imaging exam. It publishes scheduled orders on a
**Modality Worklist (MWL) server**. An imaging device asks that server "which orders are
waiting for me?" with a DICOM **C-FIND** query, and receives one response per order.

Each response has the patient details, an **accession number** (the order number), a
**Study Instance UID** (the study the images must go into), and a **Scheduled Procedure
Step Sequence**. The sequence says *how* and *where* the exam is to be done: the
**modality** (type of device, for example `OP` for ophthalmic photography), the **station
AE title** (which device), and the date and time.

The gateway acts as the imaging device. The phone never talks DICOM.

## How the gateway queries

Code: `src/infrastructure/dicom/WorklistClient.ts` (`buildKeys`) and
`src/application/services/WorklistService.ts`.

On every `GET /worklist` the gateway runs:

```text
findscu -W <mwl.host> <mwl.port> -aec <mwl.called_ae> -aet <mwl.calling_ae> -k <key> -k <key> ... -X -od <temporary folder>
```

- `-W` selects the Modality Worklist information model.
- `-aec` is the **called AE title**, the name of the worklist server (for example
  `FREEDOM_MWL`). `-aet` is the **calling AE title**, the gateway's own name (default
  `VISILANT`). Many servers accept only calling AE titles that they know, so hospital IT
  must register the gateway's AE title and its IP address.
- `-X -od` writes each response to a file. The gateway converts each file to JSON with
  `dcm2json`, reads it, then deletes the folder. Nothing from the worklist is stored.

### Keys sent

A key with a value is a **matching key** (a filter). A key without a value is a **return
key** (please send this field back).

| Tag | Name | Sent as | From |
|---|---|---|---|
| (0008,0050) | Accession Number | matching if `?accession_number=` is given, else return | query string |
| (0010,0020) | Patient ID | matching if `?patient_id=` is given, else return | query string |
| (0040,1001) | Requested Procedure ID | matching if set, else return | `mwl.requested_procedure_id` |
| (0010,0010) | Patient's Name | return | |
| (0010,0030) | Patient's Birth Date | return | |
| (0010,0040) | Patient's Sex | return | |
| (0008,0090) | Referring Physician's Name | return | |
| (0020,000D) | Study Instance UID | return | |
| (0032,1060) | Requested Procedure Description | return | |
| (0040,0100) | Scheduled Procedure Step Sequence | sequence, with the keys below | |
| &nbsp;&nbsp;(0008,0060) | Modality | matching if set, else return | `mwl.modality` |
| &nbsp;&nbsp;(0040,0001) | Scheduled Station AE Title | matching if set, else return | `mwl.scheduled_station_ae` |
| &nbsp;&nbsp;(0040,0002) | Scheduled Procedure Step Start Date | matching if `?date=` is given, else return | query string |
| &nbsp;&nbsp;(0040,0003) | Scheduled Procedure Step Start Time | return | |
| &nbsp;&nbsp;(0040,0006) | Scheduled Performing Physician's Name | return | |
| &nbsp;&nbsp;(0040,0007) | Scheduled Procedure Step Description | return | |
| &nbsp;&nbsp;(0040,0009) | Scheduled Procedure Step ID | return | |

There is **no date filter by default**. The worklist is expected to hold only open orders,
and a "today only" filter would hide an order booked yesterday for a patient who is
in the room now.

## The three filters

Without a filter, the worklist server returns **every open order in the hospital**, and
an operator could photograph a patient against the wrong order. Set at least one filter.
The gateway logs a warning at start-up when none is set.

All three are in the `mwl` section of `config.json`, and in **Advanced settings** of the
setup wizard (procedure ID is on the main form). When more than one is set, an order must
match all of them.

| Setting | DICOM tag | Use it when |
|---|---|---|
| `requested_procedure_id` | Requested Procedure ID (0040,1001) | The HIS uses one **fixed code** for this exam type on every order |
| `modality` | Modality (0008,0060), inside the step | The orders for this device have a **modality that no other device uses** |
| `scheduled_station_ae` | Scheduled Station AE Title (0040,0001), inside the step | The HIS **schedules orders to a named device**. This is the most common and most exact choice |

### How to choose

1. Ask hospital IT how the HIS sends an order to a specific device. Most worklists route
   by **station AE title**: IT sets the scheduled station of the anterior-segment orders to
   the gateway's AE title (for example `VISILANT`). Then set
   `scheduled_station_ae` to that value.
2. Check what Requested Procedure ID means in that HIS. In many systems it is **a different
   number on every order**, like the accession number. Then it cannot be a filter: leave it
   empty.
3. Use `modality` only if the modality is not shared. `OP` (Ophthalmic Photography) is
   also used by **fundus cameras**. At Aravind `OP` means fundus photography, so an `OP`
   filter would show fundus patients on the phone.

### Matching rules

These are DICOM rules. The worklist server applies them, not the gateway.

- A plain value matches exactly: `VISILANT` matches `VISILANT` only.
- `*` matches any number of characters and `?` matches one character. `ASP*` matches
  `ASP01` and `ASP02`.
- A lone `*` is meant to match everything. Some servers apply it only to orders where the
  field has a value, and drop orders where it is empty. To match everything, **remove the
  key** from `mwl` in `config.json` (or leave the field blank in the setup wizard) rather
  than writing `*`. An empty string `""` is not allowed: the gateway refuses to start.
- Date matching accepts a single date `20261010` or a range `20261001-20261031`.

## What the gateway does with the responses

1. One response can have several scheduled steps. Each step becomes **one row** on the
   phone.
2. A response without an Accession Number or a Patient ID is **dropped**, because the
   gateway cannot file a photograph without them. The log counts dropped rows but never
   shows their contents.
3. If the response has a Study Instance UID, the gateway **uses it exactly**. Then the
   photographs go into the study that the HIS created. If it is missing, the gateway makes
   one from the accession number and `study_uid_root`, so all photographs for that order
   share a study.
4. Patient's Sex is reduced to `M`, `F` or `O`.
5. Names and dates stay in DICOM form (`FAMILY^GIVEN`, `YYYYMMDD`). The phone formats them.
6. Orders that already have a completed screening are removed from the list, even if the
   worklist server still returns them. An order with a screening in progress carries its
   delivery status (`submission`).

The row returned to the phone is defined in `src/application/dto/worklist.dto.ts`
(`WorklistEntryDto`).

## Test the worklist by hand

Run this in PowerShell on the gateway computer. If `findscu` is not found, first run
`cd "C:\Program Files\Visilant\InSight-Gateway\runtime\dcmtk\bin"` and type `.\findscu`
instead of `findscu`. It asks only for procedure and scheduling fields, so you can see how the orders are coded.
The server may still send patient details: read them on screen only, and do not paste
them into chat, email or tickets.

```powershell
findscu -v -W -aet VISILANT -aec <WORKLIST_AE> <host> <port> `
  -k RequestedProcedureID -k RequestedProcedureDescription `
  -k "ScheduledProcedureStepSequence[0].Modality" `
  -k "ScheduledProcedureStepSequence[0].ScheduledStationAETitle" `
  -k "ScheduledProcedureStepSequence[0].ScheduledProcedureStepDescription" `
  -k "ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate"
```

Add `=VALUE` to a key to try a filter, for example
`-k "ScheduledProcedureStepSequence[0].ScheduledStationAETitle=VISILANT"`.

If the association is rejected, the server does not accept the calling AE title or IP
address: hospital IT must register it.

## Changing the worklist query

### Change a filter value at a site

Edit `mwl` in `C:\ProgramData\Visilant\config.json` (or `config.json` in development) and
restart the gateway. No code change is needed. Config is checked at start-up: an unknown
or misspelt key stops the gateway with a clear error.

### Add a new filter (for example Requested Procedure Code)

1. **Config.** Add an optional field to `MwlNodeConfig` in `src/config/config.schema.ts`
   with class-validator rules (`@IsOptional() @IsString() @MaxLength(16)`).
2. **Query.** In `WorklistClient.buildKeys`, send the tag as a matching key when the value
   is set. Top-level tags go in `RETURN_KEYS` and the `matching` map. Tags inside the
   Scheduled Procedure Step go through `sps(tag, value)`. Add the tag number to
   `src/infrastructure/dicom/dicom.tags.ts` if it is not there.
3. **Wizard (optional).** Add a field in `src/presentation/ui/setup/setup.js`.
4. **Start-up warning.** Include the new key in the "no worklist filter" check in
   `src/index.ts`.
5. **Tests.** Extend `tests/worklist-client.test.ts` to check the exact `-k` arguments.
   Extend `tests/config.test.ts` for validation.
6. **Docs.** Update this page and [configuration.md](configuration.md).

### Return a new field to the phone

1. Add the tag to `RETURN_KEYS` or `SPS_RETURN_KEYS` in `WorklistClient.ts`.
2. Read it in `WorklistService.toEntry` or `toScheduledStep` and add the field to
   `WorklistEntryDto` or `ScheduledStepDto`.
3. The phone sends the row back unchanged with each photograph, and the gateway rejects
   unknown keys. So a new field must be **optional** in the DTO, and the gateway must be
   updated before any phone that sends it.
4. If the field must go into the DICOM file, see [dicom-output.md](dicom-output.md).
5. Extend `tests/worklist-service.test.ts`.
