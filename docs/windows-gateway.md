# Windows gateway installation and one-time setup

The gateway runs on a Windows x64 computer on the hospital network. The existing
InSight-Gateway phone app and APK need no changes. The Windows bundle includes Node
22, the gateway's production dependencies, DCMTK and portable ImageMagick. Installation
and everyday operation do not download software or require internet access.

## Prepare before the Aravind call

Have site IT confirm a stable/reserved Windows LAN address and supply:

- Worklist and PACS server addresses, ports and remote AE titles.
- Permission to use the gateway calling AE (`VISILANT` by default) at each endpoint.
- How orders for this device are marked: a scheduled station AE title, a modality used by
  no other device, or a fixed procedure ID. See [worklist.md](worklist.md#the-three-filters).
- The agreed sent-image retention policy.
- A synthetic order for the first screening and someone who can inspect its study in PACS.

The wizard prefills `ARAVIND`, gateway port `8080`, both DICOM ports `104`, both
calling AEs `VISILANT`, account name `aravind.operator`, and Visilant's DICOM UID root
`1.2.826.0.1.3680043.10.1338`. These are editable
convenience defaults, **not confirmed hospital settings**. Remote hosts/AE titles,
procedure ID, email and password are deliberately not invented. Use a
site-specific centre code if more than one centre is being installed.

The default queue settings are immediate sending, a 30-second retry interval, and
20 attempts. `KEEP` retains the latest 10 sent images, matching the existing gateway
configuration default. Waiting images are never removed by setup. Confirm retention
with IT in Advanced settings. The wizard fixes database/capture paths beneath
`C:\ProgramData\Visilant`, even when a prepared JSON file specifies other paths.

To prepare a site file, fill a copy of `config.example.json` with confirmed details
and load it using **Have a prepared site file?**. It must satisfy the existing config
schema and should include a worklist filter. Do not include credentials or patient data.
Keep site files out of Git. A prepared file avoids typing the hospital fields during
the remote call; the wizard still tests the connections on the actual computer.

## Install and complete setup

1. Verify the ZIP's SHA-256 against the separately supplied release checksum. Extract
   the entire ZIP; retain its application, runtime and manifest files together.
2. From the extracted bundle folder, run one command in PowerShell:

   ```powershell
   .\Gateway.cmd
   ```

   You can also double-click **Gateway.cmd**. Allow Windows administrator elevation.
   The command installs and starts the background gateway, then opens the browser
   wizard. No second terminal or manual service/start commands are needed.
   The installer checks payload hashes and the Windows SQLite runtime, installs under
   `C:\Program Files\Visilant\InSight-Gateway`, protects the data directory for SYSTEM
   and Administrators, and registers a Windows startup task with automatic restart.
   The task runs as SYSTEM; use local fixed storage, not mapped network drives.
3. Complete the browser wizard at `http://127.0.0.1:8081` **on the Windows computer**:
   check the computer, save/test hospital connections, and create the first account.
   That account has the existing `ADMIN` role and also works on the phone. The
   password is hashed in SQLite and is never written to the setup progress file.
4. Enter the displayed LAN address and that account on the phone's existing login
   screen. Refresh **Patients to Screen**. The wizard detects successful sign-in and
   worklist requests from a network client; confirm that client was the intended phone.
   If several network adapters are listed, ask IT which address the phone can reach.
5. Perform a **synthetic** screening. The wizard separately shows gateway receipt,
   PACS acceptance and waiting/failed counts. Have IT confirm that the intended
   synthetic order and images appear in the correct PACS study. Connectivity alone
   does not establish worklist matching, image display or site acceptance.
6. Restart the Windows computer. Reopen **Gateway Setup** from the desktop and confirm
   the phone reconnects. The installed wizard requires an observed restart before
   completion, plus explicit confirmation of startup, synthetic data and PACS viewing.
7. Select **Finish setup**. Subsequent visits show a small status page with worklist,
   PACS and queue status and a link to the existing authenticated gateway dashboard.

The installer adds one inbound Windows Firewall rule, `Visilant InSight-Gateway`. It
allows only the bundled `node.exe`, only TCP on the gateway port (8080 unless changed
in the wizard), and only from the local subnet. It applies to the Domain, Private
**and Public** profiles: Windows often classes a hospital LAN as Public on a PC that
is not domain-joined, and phones would then be silently blocked. The port and
local-subnet limits keep the Public profile narrow. Running **Gateway.cmd** again
checks the rule and recreates it if it is missing or has the wrong scope. Each gateway
start also moves the rule to the port saved in the wizard. If you change the gateway
port, restart the computer or run **Gateway.cmd** again before the phone test.
Hospital IT must approve routing or additional firewall rules for a phone on another
VLAN. Setup itself binds only to
loopback on port 8081 and checks Host, Origin, Fetch Metadata and a per-launch request
token. The phone continues to use the gateway's configured port and existing HTTP
contract. This change does not add TLS or change existing operator authorization.

## Resume, support and existing installations

The wizard uses the same Visilant blue (`#3B69DB`) and white logo as the gateway dashboard.

Saved hospital settings, the created account, verification timestamps and completion
survive a page close or restart. Use **Save & test connections** to save the hospital
form; incomplete/unsaved fields and passwords are not restored. Failed connection
checks retain saved settings for correction. Configuration cannot be replaced through
the wizard after account activation. An interruption between account creation and
configuration publication requires the **same original account and password** to resume.

Run **Gateway.cmd** again or use the desktop shortcut to resume a successful
installation. The command detects the installed files and task, starts that existing
installation if necessary, and opens the saved setup; it never overwrites or upgrades
an existing deployment. Incomplete/unknown installations require administrator repair.
An interrupted installer may need administrator repair of its files/task/firewall rule;
keep the data folder intact. Upgrades still require the existing consistent backup and
migration procedure. Never delete a database, WAL or capture folder to restart setup.

**Download support report** exports a deliberate allowlist: build identity, platform,
runtime, setup timestamps, aggregate delivery counts and component health. It excludes
patient data, credentials, tokens, raw errors, DICOM files and the full configuration.
Setup checks observe the first installation period; after completion, use the dashboard
for operational queue investigation. Completion records operator attestations and
observed tests, not clinical/model validation or a blanket acceptance certificate.

The launcher owns one gateway child and retries a failed child after five seconds.
A child exits if its launcher disappears; gateway startup retains the existing queue
recovery behavior. Task Scheduler restarts the launcher after failure. Port 8081 also
prevents a second launcher from starting another gateway. Do not separately run
`npm start` against the same installed state.

## Logs and troubleshooting

Both the launcher and the gateway write to the console and to a rotating file in
`C:\ProgramData\Visilant\logs`:

- `launcher.log` records setup startup, the cause of a launcher failure (error name and
  code, or a configuration sentence), and each gateway exit with its exit code and signal.
- `gateway.log` records the gateway's own events, including queue and DICOM failures.
- `install-<date>.log` is a transcript of each installer run. When the installer
  fails, its window stays open with the error and the path of this file.
- `firewall.log` is written only when a start repairs the firewall rule or cannot
  check it.

The folder is readable by administrators only.

Each file rotates at 5 MB and five files are kept, so logs cannot fill the disk. The
logs contain no patient data, credentials or DICOM command lines. Check these files
first when the gateway restarts repeatedly, then send the relevant lines to IT or
support. Do not delete the data folder to clear logs.

## Build the Windows bundle

Build on **Windows x64** with Node 22 and the root lockfile installed. Supply complete
portable tool distributions, including DLLs, modules and license notices; DCMTK must
have `bin/`, and ImageMagick must have `magick.exe` at its root. The portable ImageMagick
ZIP (`ImageMagick-7.x-portable-Q16-x64.zip`) is preferred. A copy of an installed
ImageMagick also works, because `run.ps1` points it at its bundled `modules\coders`
folder; without that it looks for its JPEG module in registry keys the site computer does
not have, and every rotated photograph fails with `RegistryKeyLookupFailed
CoderModulesPath`. The packager test-converts a JPEG the same way before it builds, and
step 1 of the setup wizard converts one on the site computer. Keep the Node archive's
`LICENSE` beside `node.exe`. Verify redistribution terms for the supplied distributions.

```powershell
npm.cmd ci
powershell.exe -NoProfile -File .\windows\package.ps1 `
  -DcmtkDirectory C:\Tools\dcmtk `
  -ImageMagickDirectory C:\Tools\ImageMagick
```

The builder compiles gateway/UI assets, installs production dependencies in staging
on Windows, tests the native SQLite addon, copies the runtime/tools, and generates a
manifest, ZIP and checksum under `dist/windows/`. It does not build or package an APK.
Do not create a Windows bundle using macOS/Linux `node_modules`.

For source development on a supported computer with Node 22, DCMTK and ImageMagick:

```sh
npm ci
npm run build
GATEWAY_SETUP_DIR=/absolute/path/to/isolated-test-data npm run setup
```

Open `http://127.0.0.1:8081`. The developer launcher does not register an OS startup
service; manual startup confirmation is for sites with an independently managed
supervisor. Production Windows delivery needs a clean-machine install, reboot,
firewall, phone and real site PACS test against the actual built ZIP. A macOS unit or
browser pass does not verify those Windows behaviors.
