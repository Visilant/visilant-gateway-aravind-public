# Development

How to run the gateway from source on a Windows computer, test it, and make the most
common changes. Commands are for **PowerShell**. Windows 10 or 11, 64-bit.

If you only need to **install** a gateway and connect the phone, follow
[windows-setup.md](windows-setup.md) instead. You do not need anything here for that.

## 1. Tools

If you have already run [windows-setup.md](windows-setup.md) on this computer, you have
Git, Node 22, DCMTK and ImageMagick. Otherwise:

| Tool | Why | How to get it |
|---|---|---|
| **Git for Windows** | Clone and commit | https://git-scm.com/download/win |
| **Node 22, 64-bit** | Runtime. `package.json` allows only 22. `better-sqlite3` has Windows builds for Node 22, **not 24**, so a newer Node fails at `npm ci` with a node-gyp or Visual Studio error | nvm-windows (`nvm install 22`, then `nvm use 22`), or the Node 22 LTS installer from https://nodejs.org |
| **DCMTK** and **ImageMagick 7 (portable)** | The DICOM tools and `magick` | Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1` once: it downloads both into `C:\Tools` and adds them to `PATH` before it builds and installs. Or follow the manual steps below |
| **Docker Desktop** (optional) | A local test PACS and worklist (dcm4chee), and `npm run e2e` | https://www.docker.com/products/docker-desktop/ with the WSL 2 backend. Not needed if you develop against your own test PACS |

**Manual DCMTK and ImageMagick.** Extract the DCMTK Windows x64 ZIP from
https://dicom.offis.de/download/dcmtk/ to `C:\Tools\dcmtk`, and the
`ImageMagick-7.x-portable-Q16-x64` archive from https://imagemagick.org/script/download.php#windows
to `C:\Tools\ImageMagick`. Use the **portable** ImageMagick, not the installer (see
[troubleshooting.md](troubleshooting.md#capture-could-not-be-read-as-a-jpeg-image)). Then
add both to `PATH` and open a new PowerShell window:

```powershell
[Environment]::SetEnvironmentVariable('Path', $env:Path + ';C:\Tools\dcmtk\bin;C:\Tools\ImageMagick', 'User')
```

If you cannot change `PATH`, point the gateway at each tool with an environment variable
(`FINDSCU_BIN`, `MAGICK_BIN`, ...). See [configuration.md](configuration.md#environment).

Check in a **new** PowerShell window:

```powershell
node -v                # v22.x.x
node -p process.arch   # x64
echoscu --version
magick -version
```

Set this once so Git does not rewrite every file's line endings:

```powershell
git config --global core.autocrlf false
```

## 2. First run from source

```powershell
cd visilant-gateway-aravind-public
nvm use 22        # only with nvm-windows
npm ci
```

`npm ci` must finish **without compiling anything**. If you see `node-gyp`, `MSBuild` or
"Visual Studio", the wrong Node is active.

### Pick a test PACS

**Your own test PACS and worklist.** Use their addresses and AE titles in `config.json`
below. Use only test patients.

**Or the local one in Docker:**

```powershell
docker compose -f dev/docker-compose.pacs.yml up -d
```

It takes one to two minutes the first time. It is ready when this returns without error:
`echoscu localhost 11112 -aec DCM4CHEE -aet VISILANT`.

| Local archive | |
|---|---|
| DIMSE (C-ECHO, C-FIND, C-STORE) | `localhost:11112` |
| Worklist AE title | `WORKLIST` |
| Archive AE title | `DCM4CHEE` |
| Web viewer | http://localhost:8008/dcm4chee-arc/ui2 |

Add five made-up orders to it with `node dev/seed-mwl.mjs 5` (station `VISILANT`, modality
`OP`).

### config.json

Make a `config.json` in the repository root. This one is for the local Docker archive;
for your own test PACS change `host`, `port` and `called_ae`. Relative paths with forward
slashes are fine.

```json
{
  "centre_code": "DEV",
  "listen_port": 8080,
  "storage_root": "captures",
  "database_path": "data/gateway.db",
  "study_uid_root": "1.2.826.0.1.3680043.10.1338",
  "mwl":   { "host": "localhost", "port": 11112, "called_ae": "WORKLIST", "calling_ae": "VISILANT", "scheduled_station_ae": "VISILANT" },
  "store": { "host": "localhost", "port": 11112, "called_ae": "DCM4CHEE", "calling_ae": "VISILANT" }
}
```

`config.json`, `data/` and `captures/` are ignored by Git. Never commit them.

### Run it

```powershell
npm run users -- add dev@example.org dev --admin       # prints a password once
npm run dev
```

The first time, Windows Firewall may ask about `node.exe`. Allow it on **Private**
networks if you want to test with a phone.

**Port 8080 is taken** if the installed gateway from [windows-setup.md](windows-setup.md)
runs on the same computer. Set `"listen_port": 8090` in your `config.json` instead.

Check it. In PowerShell `curl` is not the real curl, so use `Invoke-RestMethod`:

```powershell
Invoke-RestMethod http://localhost:8080/health

$signin = Invoke-RestMethod -Method Post -Uri http://localhost:8080/signin -ContentType 'application/json' `
  -Body '{"email":"dev@example.org","password":"<password>"}'
$token = $signin.data.token
Invoke-RestMethod http://localhost:8080/worklist -Headers @{ Authorization = "Bearer $token" }
```

`/health` returns `503` with a `detail` when something is wrong, for example
`echoscu not found` when DCMTK is not on `PATH`.

The operator page is at http://localhost:8080/ui. Under `npm run dev` it is served from
`src/presentation/ui`; `npm run build` copies it to `build/` for `npm start`.

### Test with the phone against your source gateway

1. Put the phone on the same Wi-Fi as the computer.
2. Find the computer's address with `ipconfig` (the IPv4 address of the Wi-Fi or Ethernet
   adapter, not a WSL or Docker one).
3. If you cancelled the firewall prompt, allow the port:
   ```powershell
   New-NetFirewallRule -DisplayName "Visilant dev gateway" -Direction Inbound -Protocol TCP -LocalPort 8080 -Profile Private -Action Allow
   ```
4. On the phone, sign in with that address, the port and the account you created.

Remove the rule afterwards: `Remove-NetFirewallRule -DisplayName "Visilant dev gateway"`.

### Run the setup wizard from source

This runs the same wizard the installer uses, without installing anything:

```powershell
npm run build
$env:GATEWAY_SETUP_DIR = "$HOME\visilant-setup-test"
npm run setup
```

Open http://127.0.0.1:8081. Use an empty folder for `GATEWAY_SETUP_DIR`, never
`C:\ProgramData\Visilant`. Stop the installed gateway first, or it already holds port 8081.

## 3. Tests

| Command | What it runs |
|---|---|
| `npm test -- --runInBand` | All Jest tests. The tests that need real DCMTK are skipped |
| `$env:TEST_DCMTK = '1'; npm test -- --runInBand` | Also builds and reads real DICOM files with DCMTK and ImageMagick |
| `npm run e2e` | Needs Docker Desktop. Builds the gateway, starts the local archive if needed, and drives two real gateways over HTTP the way the phone does: worklist, upload, delivery, PACS outage, back-off, `FAILED` and retry, power cut during a send, repeated uploads. Add `-- --keep` to keep its folders and logs. The clean-shutdown check is skipped on Windows, which cannot ask a process to shut down gracefully |
| `npm run check` | Typecheck, tests and build. CI runs the same steps |

Tests live in `tests/`, one file per unit (`worklist-client.test.ts`,
`capture-service.test.ts`, `sync-worker.test.ts`, ...).

CI runs on Ubuntu. If a test passes in CI but fails on your computer, the usual causes are
a tool missing from `PATH` or antivirus holding a temporary file open. Fix the cause or
report it; do not skip the test. Windows Defender can make `npm ci` and Jest several
times slower; excluding the repository folder from real-time scanning helps on a
development computer (not on a gateway at a site).

## 4. Database changes

The schema is defined by the entities in `src/infrastructure/database/entities/`.

1. Change the entity.
2. Generate the migration: `npm run migration:generate -- migrations/DescribeTheChange`.
   Never write one by hand.
3. **Read it.** SQLite cannot add a constraint to a table, so TypeORM rebuilds the table
   (create, copy, drop, rename). That is correct but long.
4. Apply it with `npm run migration:run`, then run
   `npm run migration:generate -- migrations/Check` and confirm that it reports no changes.
5. Commit the entity and the migration together.

Migrations run automatically at start-up on every installed gateway. A migration that
fails, or that loses data, breaks a centre's gateway with no one on site to fix it.

## 5. Recipes

### Change the worklist filter

No code change: edit `mwl.requested_procedure_id`, `mwl.modality` or
`mwl.scheduled_station_ae` in `config.json` and restart. See
[worklist.md](worklist.md#the-three-filters).

### Add a worklist filter or a returned field

See [worklist.md](worklist.md#changing-the-worklist-query).

### Add or change a DICOM tag

See [dicom-output.md](dicom-output.md#changing-the-dicom-output).

### Add a config setting

1. Add the property with class-validator rules to `src/config/config.schema.ts`. A nested
   object needs both `@ValidateNested()` and `@IsDefined()`: `@ValidateNested()` alone
   accepts a missing object.
2. If the setup wizard should show it, add a field in `src/presentation/ui/setup/setup.js`
   and a default in `defaultConfig` in `src/setup/SetupService.ts`.
3. Add it to `config.example.json` if every site needs it.
4. Test it in `tests/config.test.ts`.
5. Add it to [configuration.md](configuration.md).

### Add an HTTP endpoint

1. Request DTO in `src/application/dto/` with class-validator rules.
2. Logic in a service in `src/application/services/` (`@Service()`).
3. A controller method in `src/presentation/controllers/` that only calls the service.
   Protect it with `@Authorized()`. Map domain errors to HTTP errors in the controller.
4. Register a new controller in `src/presentation/server.ts`.
5. Test in `tests/server-routes.test.ts` or a new test file.
6. Document it in [api.md](api.md).

### Change how often or how many times the gateway retries

`sync_interval_seconds` and `max_send_attempts` in `config.json`. The back-off (30 s
doubling to 30 min) is `BACKOFF_BASE_MS` and `BACKOFF_CAP_MS` in
`src/application/services/SyncWorker.ts`.

## 6. Build the Windows bundle by hand

`windows\setup.ps1` builds the bundle and installs it in one go. To build only the ZIP,
for example to send to a site:

```powershell
npm.cmd ci
powershell.exe -NoProfile -File .\windows\package.ps1 `
  -DcmtkDirectory C:\Tools\dcmtk `
  -ImageMagickDirectory C:\Tools\ImageMagick
```

The output is `dist\windows\InSight-Gateway-<date>.zip` and a `.sha256` file. Build from a
clean, committed tree: the bundle's `manifest.json` records the commit and whether the
tree was dirty. If the script stops:

| Message | Cause | Fix |
|---|---|---|
| `Build with Node 22.` / `Build with Windows x64 Node.` | Wrong `node.exe` first on `PATH` | `nvm use 22`, or install the 64-bit Node 22 |
| `Missing DCMTK bin\<tool>.exe` | Incomplete DCMTK folder | Extract the full DCMTK ZIP; it must have a `bin` folder |
| `Use a portable ImageMagick distribution with magick.exe at its root.` | Wrong folder | `magick.exe` must be directly inside the folder |
| `ImageMagick could not read and convert a JPEG image.` | ImageMagick cannot find its modules | Use the portable build |
| `Repository dependencies are missing.` | `npm ci` not run | Run `npm.cmd ci` first |
| `Use the official Node Windows archive and retain its LICENSE alongside node.exe.` | `node.exe` without its `LICENSE` file | Install Node from the official installer or with nvm-windows |

More about the bundle and the installer: [windows-gateway.md](windows-gateway.md).

## 7. Windows pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `npm`: "running scripts is disabled" | PowerShell execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` |
| `npm ci` compiles with node-gyp, or a Visual Studio error | Node 24 or 32-bit Node | Node 22 x64 |
| `nvm use` says "version not specified" | nvm-windows does not read `.nvmrc` | `nvm use 22` |
| `/health` returns 503 "echoscu not found" | DCMTK not on `PATH` | Add `C:\Tools\dcmtk\bin` to `PATH` and open a new window |
| `magick` not found | ImageMagick not on `PATH` | Add `C:\Tools\ImageMagick` to `PATH` |
| `convert` does something strange | `convert.exe` on Windows is a disk tool | The gateway always calls `magick` |
| `TEST_DCMTK=1 npm test` "not recognized" | That is bash syntax | `$env:TEST_DCMTK = '1'; npm test -- --runInBand` |
| `curl` returns an object or asks for parameters | PowerShell alias | `Invoke-RestMethod`, or `curl.exe` |
| Docker hangs or the archive does not start | Docker Desktop not running, WSL 2 missing, or virtualisation off in the BIOS | Start Docker Desktop and wait for "running" |
| Port 8080 or 8081 in use | The installed gateway, or another program | `Get-NetTCPConnection -LocalPort 8080` shows the process ID |
| Phone cannot reach the source gateway | Firewall, or the wrong adapter's address | Allow TCP 8080 on Private; use the Wi-Fi or Ethernet address from `ipconfig` |
| Git shows every file as modified | `core.autocrlf` rewrote line endings | `git config --global core.autocrlf false`, then clone again |

## Before you push

The rules in [CONTRIBUTING.md](../CONTRIBUTING.md) apply in full:

- `npm run check` passes.
- Docs that describe what you changed are updated in the same commit.
- No patient data, `config.json`, database, `.dcm` file, log or screenshot from a site is
  in the commit.
