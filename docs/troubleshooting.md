# Troubleshooting

Problems seen at sites, what causes them, and how to fix them. Commands are for
**PowerShell as administrator** on the gateway computer unless noted.

## Where to look first

| What | Where |
|---|---|
| Gateway log | `C:\ProgramData\Visilant\logs\gateway.log` |
| Launcher log (start-up, crashes) | `C:\ProgramData\Visilant\logs\launcher.log` |
| Installer runs | `C:\ProgramData\Visilant\logs\install-<date>.log` |
| Config | `C:\ProgramData\Visilant\config.json` |
| Installed program | `C:\Program Files\Visilant\InSight-Gateway` |
| Health check | `http://127.0.0.1:8080/health` in a browser on the gateway computer |
| Operator page | `http://127.0.0.1:8080/ui` |

Search the gateway log:

```powershell
Select-String -Path "$env:ProgramData\Visilant\logs\gateway.log" -Pattern "failed" | Select-Object -Last 20
```

In Command Prompt (not PowerShell) use `findstr`:

```bat
findstr /c:"failed" "%ProgramData%\Visilant\logs\gateway.log"
```

Restart the gateway:

```powershell
Stop-ScheduledTask -TaskName "Visilant InSight-Gateway"; Start-ScheduledTask -TaskName "Visilant InSight-Gateway"
```

**Never delete `C:\ProgramData\Visilant` or anything in it** to "start again". It holds
the config, the accounts and every photograph that has not reached the PACS yet.

## "capture could not be read as a JPEG image"

**Seen on the phone** after a photograph, with "Submission failed".

**Log line:**
`DICOM JPEG normalise failed: magick.exe: RegistryKeyLookupFailed 'CoderModulesPath'`

**Cause.** The ImageMagick in the bundle is a copy of an *installed* ImageMagick, not the
portable build. An installed copy finds its JPEG module through Windows registry keys that
its installer wrote. On the gateway computer those keys do not exist, so every conversion
fails. `magick -version` still works, which is why the old setup check passed. Most phone
photos have an EXIF rotation and need conversion, so most uploads fail.

**Fix.** Tell ImageMagick where its modules are. Current bundles do this in `run.ps1`.
For an older installation:

1. Test:
   ```powershell
   $im="$env:ProgramFiles\Visilant\InSight-Gateway\runtime\imagemagick"; $env:MAGICK_CODER_MODULE_PATH="$im\modules\coders"; $env:MAGICK_FILTER_MODULE_PATH="$im\modules\filters"; $env:MAGICK_CONFIGURE_PATH=$im; & "$im\magick.exe" logo: "$env:TEMP\vtest.jpg"; & "$im\magick.exe" "$env:TEMP\vtest.jpg" -auto-orient "$env:TEMP\vtest2.jpg"; dir "$env:TEMP\vtest2.jpg"
   ```
   It must list `vtest2.jpg` with no red error.
2. Open `run.ps1`:
   ```powershell
   notepad "$env:ProgramFiles\Visilant\InSight-Gateway\run.ps1"
   ```
3. The end of the file must be exactly this. The three `MAGICK_..._PATH` lines go
   **after** the `MAGICK_BIN` line and **before** the line that starts `node.exe`.
   `exit $LASTEXITCODE` must be the last line, on its own:
   ```powershell
   $env:MAGICK_BIN = Join-Path $PSScriptRoot 'runtime\imagemagick\magick.exe'
   $env:MAGICK_CODER_MODULE_PATH = Join-Path $PSScriptRoot 'runtime\imagemagick\modules\coders'
   $env:MAGICK_FILTER_MODULE_PATH = Join-Path $PSScriptRoot 'runtime\imagemagick\modules\filters'
   $env:MAGICK_CONFIGURE_PATH = Join-Path $PSScriptRoot 'runtime\imagemagick'
   & (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'application\build\src\setup\launcher.js')
   exit $LASTEXITCODE
   ```
4. Save, restart the gateway, and press **Try Again** on the phone.

Current gateways also answer this fault with HTTP 500, not 400, so the phone keeps the
photograph and retries by itself. Step 1 of the setup wizard now converts a real JPEG,
so the fault shows before the first patient.

## Connection test fails in the setup wizard

The wizard sends a DICOM C-ECHO to each server.

| Message or log | Cause | Fix |
|---|---|---|
| `timed out` | Wrong address or port, or a firewall blocks it | Check host and port with IT. Test from the gateway computer: `Test-NetConnection <host> -Port <port>` |
| `Association Rejected` / `Called AE Title Not Recognized` | Wrong hospital AE title | Get the exact AE title from IT. It is case-sensitive |
| `Association Rejected` / `Calling AE Title Not Recognized` | The server does not know the gateway | IT must register the gateway AE title (`VISILANT`) **and the gateway computer's IP address** on that server |
| `not found` | A DCMTK tool is missing | Reinstall the complete bundle |

## C-ECHO works, but images do not reach the PACS

A C-ECHO proves only that the server answers. Storing can still be refused.

- Look in the gateway log for `C-STORE failed:` and the PACS's own message.
- Many archives accept C-ECHO from anyone but C-STORE only from known AE titles. IT must
  allow `VISILANT` to **store**.
- Some archives refuse the Ophthalmic Photography SOP class or JPEG Baseline transfer
  syntax unless it is enabled. The PACS administrator can check this.
- Failed images retry for a while and then show as `FAILED` on the operator page. After
  the cause is fixed, press **Retry** there. Each Retry gives one more attempt.

## The phone shows no patients, or the wrong patients

- **No patients:** a filter is too strict, or the orders are not scheduled for this
  device. Run the `findscu` test in [worklist.md](worklist.md#test-the-worklist-by-hand)
  without filters, then add one filter at a time.
- **Every patient in the hospital:** no filter is set. The log says
  `No worklist filter is set`. Set `scheduled_station_ae` (best), `modality` or
  `requested_procedure_id`. See [worklist.md](worklist.md#the-three-filters).
- **Fundus patients appear:** the filter is `modality = OP`, which fundus cameras also use.
  Use a station filter instead.
- **An order disappears after use:** this is expected. Orders with a completed screening
  are hidden.
- **Log says `skipped N entries missing an accession number or patient ID`:** the HIS sends
  orders without these fields. The gateway cannot file a photograph without them. Ask IT
  to fill them.

## The phone cannot reach the gateway

- The phone must be on the same network as the gateway computer and use its LAN address
  (shown in the setup wizard), never `localhost`.
- The installer opens TCP port 8080 for the local subnet in Windows Firewall. If the phone
  is on another subnet or VLAN, IT must allow it.
- Ask IT to reserve the gateway computer's IP address, so that it does not change after a
  restart.

## The gateway does not start

Read `launcher.log`. The usual causes:

- **Invalid config.** The gateway refuses to start with an invalid `config.json`, and the log
  names the key. Unknown or misspelt keys are errors.
- **Port 8081 in use.** Another setup window or launcher is running. Close it.
- **Port 8080 in use.** Another program uses the gateway port.

## Updating an installed gateway

Running `Gateway.cmd` from a newer bundle does **not** update an installed gateway. It
only reopens and repairs the existing one, so that it never overwrites a working site by
accident. To apply a fix to an installed gateway, replace the changed files under
`C:\Program Files\Visilant\InSight-Gateway` by hand while the task is stopped, keep
`C:\ProgramData\Visilant` untouched, and restart. A proper upgrade command is not yet
built.
