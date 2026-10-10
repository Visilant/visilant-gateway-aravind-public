# DICOM output and delivery to the PACS

This page explains what the gateway does with a photograph: how the JPEG becomes a DICOM
object, which tags it carries, how UIDs and series are chosen, and how the file reaches
the PACS.

Code: `src/application/services/CaptureService.ts` (what goes in),
`src/infrastructure/dicom/DicomBuilder.ts` (how it is built),
`src/application/services/SyncWorker.ts` and
`src/infrastructure/dicom/DicomStoreClient.ts` (how it is sent).

## From JPEG to DICOM

The phone uploads a JPEG (at most 32 MB) as `POST /captures`, with the worklist row, the
eye (`L` or `R`) and optional details. See [api.md](api.md#capture-upload).

1. **Check the header.** `src/infrastructure/image/jpeg.ts` reads the start of the file. A
   file that is not a JPEG is rejected with HTTP 400.
2. **Normalise, only if needed.** `img2dcm` puts the JPEG into the DICOM file as it is
   (it does not decode it) and accepts only **baseline** JPEG. It also drops EXIF data, so
   a photo that the phone stored with a rotation tag would appear sideways in the PACS. If
   the JPEG is progressive or has an EXIF rotation, the gateway re-encodes it with
   ImageMagick:
   `magick in.jpg -auto-orient -interlace none -sampling-factor 2x1 -strip -quality 92 out.jpg`.
   An upright baseline JPEG goes straight to `img2dcm` without changes. Most phone photos
   carry a rotation tag, so in practice ImageMagick runs on most photos.
3. **Build.** `img2dcm -oph` writes an Ophthalmic Photography object with the tags below.
4. **Save and queue.** The `.dcm` file goes to `storage_root/<accession>/<capture id>.dcm`
   and a row with status `PENDING` goes into SQLite. The phone gets HTTP 200.

The DICOM file is built **at upload time**, not at send time. The patient details live
only inside the `.dcm` file, never in the database, and every retry sends the identical
file.

If ImageMagick itself is broken (for example a Windows installer copy that cannot find
its JPEG module), the gateway answers HTTP 500, which the phone retries later. It does
not answer 400, which would tell the phone that the photo is bad. See
[troubleshooting.md](troubleshooting.md#capture-could-not-be-read-as-a-jpeg-image).

## The DICOM object

| Item | Value |
|---|---|
| SOP Class | Ophthalmic Photography 8 Bit Image Storage, `1.2.840.10008.5.1.4.1.1.77.1.5.1` |
| Modality (0008,0060) | `OP` |
| Transfer syntax | JPEG Baseline (Process 1), `1.2.840.10008.1.2.4.50` |
| Manufacturer (0008,0070) | `Visilant` |

### Tags written

Values come from the worklist row that the phone sends back with the photograph. A value
that the worklist did not have is written empty (DICOM Type 2), never invented.

| Tag | Name | Value |
|---|---|---|
| (0010,0010) | Patient's Name | worklist |
| (0010,0020) | Patient ID | worklist |
| (0010,0030) | Patient's Birth Date | worklist |
| (0010,0040) | Patient's Sex | worklist, reduced to `M`, `F` or `O` |
| (0020,000D) | Study Instance UID | worklist (see UIDs) |
| (0008,0050) | Accession Number | worklist |
| (0020,0010) | Study ID | the accession number |
| (0008,0020) / (0008,0030) | Study Date / Time | scheduled step date and time, or the upload time |
| (0008,0090) | Referring Physician's Name | worklist |
| (0008,1030) | Study Description | Requested Procedure Description from the worklist |
| (0020,000E) | Series Instance UID | derived (see below) |
| (0008,103E) | Series Description | from the phone, or for example `Right eye, white light` |
| (0020,0011) | Series Number | see below |
| (0008,0018) | SOP Instance UID | derived (see below) |
| (0020,0013) | Instance Number | position within the series |
| (0020,0062) | Image Laterality | `L` or `R` from the phone |
| (0020,0020) | Patient Orientation | `A\L` or `A\R` |
| (0022,000D) | Pupil Dilated | `YES` / `NO` from the phone, or empty |

### Coded values

Defined in `src/infrastructure/dicom/dicom.codes.ts`.

| Sequence | Code | Meaning |
|---|---|---|
| Acquisition Device Type (0022,0015) and Device (0050,0010) | `R-1021B`, SRT | External Camera |
| Anatomic Region (0008,2218) | `32259006`, SCT | Anterior segment of eye |
| Illumination Type (0022,0016), when light is `SLIT` | `R-1020F`, SRT | Fine slit beam direct illumination |
| Illumination Type, when light is `WHITE` or `BLUE` | `R-1020E`, SRT | Dual diffuse direct illumination |
| Light Path Filter Type Stack (0022,0017), when light is `BLUE` | `111603`, DCM | Blue filter |
| Light Path Filter Type Stack, when light is `WHITE` or `SLIT` | `111609`, DCM | No filter |

When the phone does not send `light`, the illumination and filter sequences are left out.

## UIDs

All UIDs live under `study_uid_root` (Visilant's root is `1.2.826.0.1.3680043.10.1338`).
`deriveUid(seed, root)` in `src/infrastructure/dicom/util.ts` turns a SHA-256 of the seed
into digits and appends them to the root, to a total of at most 64 characters. The same
seed always gives the same UID.

| UID | Source |
|---|---|
| Study Instance UID | The worklist's own UID. Only if the worklist has none: derived from `study:<accession>` |
| Series Instance UID | Derived from `series:<study UID>:<eye>:<light>` |
| SOP Instance UID | Derived from `instance:<phone's capture ID>` |

Derived UIDs make delivery **idempotent**: a re-sent photograph has the same SOP Instance
UID, so the PACS sees a repeat, not a new image.

## Series

There is one series per eye and light, so a viewer groups for example "right eye, slit
light" together.

| | White | Blue | Slit | No light given |
|---|---|---|---|---|
| Right eye | 1 | 2 | 3 | 4 |
| Left eye | 5 | 6 | 7 | 8 |

## AI result (private tag)

The phone can send an AI result with a **white-light** photograph (`ai_assessment` in the
upload). The gateway does not run any model. It checks the format with
`isAiAssessment` (`src/domain/assessment.ts`) and rejects anything else with HTTP 400,
including any unexpected field. Patient details can therefore never enter this tag.

When the result is valid, the gateway writes it as a private element:

| Tag | VR | Value |
|---|---|---|
| (0011,0010) | LO | Private creator `VISILANT_AI_1` |
| (0011,1001) | UT | The result as JSON |

Some PACS remove private tags. Check with the site's PACS whether they keep them.

## Delivery to the PACS

`SyncWorker` runs every `sync_interval_seconds` (default 30), and also straight after an
upload when `send_immediately` is `true`.

1. It claims `PENDING` rows that are due and marks them `SENDING`.
2. For each one it runs
   `storescu <store.host> <store.port> -aec <store.called_ae> -aet <store.calling_ae> -xy <file>`.
   `-xy` offers JPEG Baseline. Without it `storescu` offers only uncompressed transfer
   syntaxes and fails.
3. **Success:** the row becomes `SENT`. The file is then kept or deleted according to
   `retention`.
4. **Failure:** the attempt count goes up and the row goes back to `PENDING` with a wait
   that doubles each time: 30 s, 1 min, 2 min ... up to 30 min.
5. After `max_send_attempts` failures (default 20) the row becomes `FAILED`. It stays on
   disk and appears on the operator page and in `/health`. An operator can press **Retry**
   (`POST /captures/:id/retry`). Retry does not reset the attempt count, so each Retry
   gives one more attempt.
6. A capture whose `.dcm` file is missing becomes `FAILED` at once.

When the gateway starts, rows left in `SENDING` (for example after a power cut) go back to
`PENDING`. A file is never deleted before the PACS has confirmed it.

### Retention

| `retention` | After a successful send |
|---|---|
| `KEEP` (default) | Keep the newest `retention_keep_count` (default 10) sent files, delete older sent files |
| `DELETE_ON_SENT` | Delete the file as soon as the PACS confirms it |

Rows are never deleted. They are the record of what was sent.

## Changing the DICOM output

### Add or change a tag

1. If the value comes from the worklist, first return it from the worklist
   ([worklist.md](worklist.md#return-a-new-field-to-the-phone)).
2. Add the field to `DicomImageTags` in `DicomBuilder.ts`.
3. Fill it in `CaptureService.toTags`.
4. Add it to `buildKeyArgs` in `DicomBuilder.ts` as `['DicomKeyword', value]`. Use the
   DCMTK keyword (as in `dcmdump` output). An `undefined` value is left out: `img2dcm -oph`
   then writes it empty only if it is a Type 2 attribute of the Ophthalmic Photography
   IOD. Anything else is simply missing.
5. Test: extend `tests/dicom-builder.test.ts` for the arguments. For a test that builds a
   real file, follow the `TEST_DCMTK` tests in `tests/dicom-inspector.test.ts` and
   `tests/assessment.test.ts`, run `TEST_DCMTK=1 npm test`, and look at the file with
   `dcmdump <file>.dcm`.
6. Run `npm run e2e` to check that the local PACS accepts it.

### Change a coded value

Edit `dicom.codes.ts`. Use the code, scheme and meaning from the DICOM standard (PS3.16).

### Change where files go

Change `store` in `config.json`. Test with `echoscu <host> <port> -aec <AE> -aet VISILANT`
before you restart the gateway.

## Never log patient data

The `img2dcm -k` arguments contain the patient's name and ID, and Node's `execFile` puts
the whole argument list into its error message. The gateway therefore logs only the
tool's stderr and exit code, never the error message itself. Keep to this when you add a
tool call (`DicomClient.run` already does it).
