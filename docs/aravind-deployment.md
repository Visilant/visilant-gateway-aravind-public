# Aravind deployment

How the gateway is set up at Aravind, what was learned during installation, and what is
still open. Host addresses are left out of this public document. They are in the
gateway's `config.json` on site and with Aravind IT.

## Systems

| Role | System | AE title | Port |
|---|---|---|---|
| Worklist (MWL) | Freedom HIS worklist | `FREEDOM_MWL` | 1090 |
| Image archive (PACS) | dcm4chee-based archive | `DCM4CHEE` | 11112 |
| Gateway (calling AE for both) | Visilant Gateway | `VISILANT` | HTTP 8080 for the phone |

Other settings:

| Setting | Value |
|---|---|
| `centre_code` | `ARAVIND` |
| `study_uid_root` | `1.2.826.0.1.3680043.10.1338` (Visilant's UID root) |
| Installed at | `C:\Program Files\Visilant\InSight-Gateway` |
| Data and logs | `C:\ProgramData\Visilant` |

## Worklist filtering: still open

At installation the worklist was **unfiltered**: the procedure ID field held `*`, and the
modality and station filters were empty. The phone therefore shows every open order in
the hospital. This was acceptable for the installation test, but **must be fixed before
real patients**.

What we learned:

- No fixed **Requested Procedure ID** for these orders was available. In many HIS
  systems it is a different number on every order, so it may not be usable as a filter.
- Aravind uses modality **`OP` for fundus photography**. A `modality = OP` filter would
  show fundus patients on the anterior-segment phone, and photographs could be filed
  against a fundus order.

Recommended: Aravind IT schedules the anterior-segment orders for this device to
**Scheduled Station AE Title `VISILANT`**. Then set
`"scheduled_station_ae": "VISILANT"` in `mwl` and **remove** the `requested_procedure_id`
key (an empty string `""` stops the gateway from starting). See [worklist.md](worklist.md#the-three-filters).

To see how Freedom codes its orders, run the `findscu` test in
[worklist.md](worklist.md#test-the-worklist-by-hand) on the gateway computer with
`-aec FREEDOM_MWL`.

## ImageMagick fault at installation

The first photograph failed with "capture could not be read as a JPEG image". The bundle
contained an installed (not portable) ImageMagick, which could not find its JPEG module
without registry keys. It was fixed on site by adding the three `MAGICK_*_PATH` lines to
`run.ps1`. The fix, and the test that now catches it, are described in
[troubleshooting.md](troubleshooting.md#capture-could-not-be-read-as-a-jpeg-image).
Current bundles include these lines.

## Before go-live

- [ ] Worklist filter set (station AE recommended) and checked with `findscu`.
- [ ] Aravind IT has registered `VISILANT` with the gateway computer's IP address on both
      `FREEDOM_MWL` and the PACS, including permission to **store**.
- [ ] The gateway computer has a reserved IP address.
- [ ] A test (not real) patient order was photographed, and Aravind confirmed the images in
      the correct study in the PACS viewer, with the right eye and orientation.
- [ ] Aravind decided whether test studies are deleted from the PACS or kept with a test
      label.
- [ ] The PACS keeps the private AI tag `(0011,1001)`, if Aravind wants the AI result
      stored.
- [ ] The computer was restarted and the gateway came back without help.
