# Developing on Windows

How to set up a Windows computer to work on the gateway: clone the repository, run it
against a local test PACS, run the tests, and build the Windows bundle. This is the
Windows version of [development.md](development.md); that document still holds the
recipes for common code changes, which are the same on every platform.

If you only need to **install or operate** a gateway at a hospital, you do not need any of
this. Read [windows-gateway.md](windows-gateway.md) and
[troubleshooting.md](troubleshooting.md) instead.

Commands below are for **PowerShell** unless noted. Windows 10 or 11, 64-bit.

## 1. Install the tools

| Tool | Why | How to install |
|---|---|---|
| **Git for Windows** | Clone and commit | https://git-scm.com/download/win. Keep the default "Git from the command line" option so `git` works in PowerShell |
| **Node 22 (x64)** | Runtime. `package.json` allows only 22. `better-sqlite3` has Windows prebuilds for Node 20 and 22, **not 24**, so a newer Node fails at `npm ci` with a node-gyp or Visual Studio error | Either [nvm-windows](https://github.com/coreybutler/nvm-windows/releases) then `nvm install 22` and `nvm use 22`, or the Node 22 LTS Windows installer from https://nodejs.org. Install the 64-bit build |
| **DCMTK** | `findscu`, `img2dcm`, `storescu`, `echoscu`, `dcm2json`, `dcmdump`, `dcmodify` | Download the Windows x64 binaries from https://dicom.offis.de/download/dcmtk/ (the `bin` folder of the newest release) and extract to `C:\Tools\dcmtk`. Add `C:\Tools\dcmtk\bin` to `PATH` |
| **ImageMagick 7, portable** | `magick`, to turn rotated or progressive JPEGs upright | Download `ImageMagick-7.x-portable-Q16-x64.zip` from https://imagemagick.org/script/download.php#windows and extract to `C:\Tools\ImageMagick`. Add `C:\Tools\ImageMagick` to `PATH` |
| **Docker Desktop** | Local test PACS and worklist (dcm4chee), and `npm run e2e` | https://www.docker.com/products/docker-desktop/. Use the WSL 2 backend. Virtualisation must be enabled in the BIOS |

Use the **portable** ImageMagick, not the installer. The installer build finds its JPEG
module through registry keys, and a copy of it breaks on any other computer. The
portable build is also what the bundle must contain, so you only download it once.
See [troubleshooting.md](troubleshooting.md#capture-could-not-be-read-as-a-jpeg-image)
for what goes wrong otherwise.

To add a folder to `PATH` for your user account, run this once, then open a new
PowerShell window:

```powershell
[Environment]::SetEnvironmentVariable('Path', $env:Path + ';C:\Tools\dcmtk\bin;C:\Tools\ImageMagick', 'User')
```

If you cannot change `PATH`, point the gateway at each tool with an environment variable
instead (`FINDSCU_BIN`, `MAGICK_BIN`, ...). See
[configuration.md](configuration.md#environment).

Check everything in a **new** PowerShell window:

```powershell
node -v            # v22.x.x
node -p process.arch   # x64
npm -v
git --version
findscu --version
img2dcm --version
magick -version
docker --version
```

### PowerShell refuses to run `npm`

If `npm` fails with "running scripts is disabled on this system", PowerShell's execution
policy is blocking `npm.ps1`. Allow local scripts for your account:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Or call `npm.cmd` instead of `npm`. The build script `windows\package.ps1` already does
this.

### Line endings

Keep the repository's line endings as they are in Git. Set this once so that Windows does
not rewrite every file to CRLF and fill your diffs with noise:

```powershell
git config --global core.autocrlf false
```

## 2. Clone and first run

```powershell
git clone https://github.com/Visilant/visilant-gateway-aravind-public.git
cd visilant-gateway-aravind-public
nvm use 22        # only with nvm-windows. Older versions do not read .nvmrc, so name the version
npm ci
docker compose -f dev/docker-compose.pacs.yml up -d
```

`npm ci` must finish **without compiling anything**. If you see `node-gyp`, `MSBuild` or
"Visual Studio" in the output, you are on the wrong Node version or a 32-bit build.
Switch to Node 22 x64 and run `npm ci` again.

The archive takes one to two minutes to start the first time. It is ready when this
returns without error:

```powershell
echoscu localhost 11112 -aec DCM4CHEE -aet VISILANT
```

| Local archive | |
|---|---|
| DIMSE (C-ECHO, C-FIND, C-STORE) | `localhost:11112` |
| Worklist AE title | `WORKLIST` |
| Archive AE title | `DCM4CHEE` |
| Web viewer | http://localhost:8008/dcm4chee-arc/ui2 |

Make a `config.json` in the repository root. Relative paths with forward slashes are fine
on Windows:

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

`config.json` is in `.gitignore`. Never commit it, and never put a real site's addresses
in it on a shared computer.

Then:

```powershell
node dev/seed-mwl.mjs 5                                # five test orders, station VISILANT, modality OP
npm run users -- add dev@example.org dev --admin       # prints a password once
npm run dev
```

The first time the gateway listens on port 8080, Windows Firewall may ask whether to
allow `node.exe`. Allow it on **Private** networks if you want to test with a phone;
cancel if you only use the browser on this computer.

Check it. In PowerShell `curl` is an alias for `Invoke-WebRequest`, so use
`Invoke-RestMethod`:

```powershell
Invoke-RestMethod http://localhost:8080/health

$signin = Invoke-RestMethod -Method Post -Uri http://localhost:8080/signin -ContentType 'application/json' `
  -Body '{"email":"dev@example.org","password":"<password>"}'
$token = $signin.data.token
Invoke-RestMethod http://localhost:8080/worklist -Headers @{ Authorization = "Bearer $token" }
```

The operator page is at http://localhost:8080/ui.

The test data from `dev/seed-mwl.mjs` is made up. Never use real patient data in
development.

### Test with a phone against your development gateway

1. Put the phone on the same Wi-Fi as the computer.
2. Find the computer's LAN address with `ipconfig` (the IPv4 address of the Wi-Fi or
   Ethernet adapter, not the WSL or Docker adapters).
3. Allow the port in Windows Firewall for the Private profile, if the first-run prompt
   was cancelled:
   ```powershell
   New-NetFirewallRule -DisplayName "Visilant dev gateway" -Direction Inbound -Protocol TCP -LocalPort 8080 -Profile Private -Action Allow
   ```
4. On the phone, sign in with that address and port 8080 and the account created above.

Remove the rule when you are done: `Remove-NetFirewallRule -DisplayName "Visilant dev gateway"`.

## 3. Tests

Environment variables are set differently in PowerShell. `TEST_DCMTK=1 npm test` is bash
syntax and does not work here.

| Command | What it runs |
|---|---|
| `npm test -- --runInBand` | All Jest tests. The tests that need real DCMTK are skipped |
| `$env:TEST_DCMTK = '1'; npm test -- --runInBand` | Also builds and reads real DICOM files with DCMTK and ImageMagick from `PATH` |
| `npm run e2e` | Needs Docker Desktop running. Builds the gateway, starts the local archive if needed, and drives two real gateways over HTTP. Add `-- --keep` to keep its temporary folders and logs |
| `npm run check` | Typecheck, tests and build. CI runs the same steps |

In Command Prompt use `set TEST_DCMTK=1` on its own line first.

CI runs on Ubuntu, not Windows. If a test passes in CI but fails on your computer, the
usual causes are a tool missing from `PATH`, or antivirus holding a temporary file open.
Fix the cause or report it; do not skip the test. Windows Defender can also make
`npm ci` and Jest several times slower. Excluding the repository folder from real-time
scanning is a reasonable fix on a development computer, not on a gateway at a site.

## 4. Run the setup wizard from source

This runs the same launcher and wizard that the Windows bundle uses, without installing
anything or registering a startup task or firewall rule:

```powershell
npm run build
$env:GATEWAY_SETUP_DIR = 'C:\Users\<you>\visilant-setup-test'
npm run setup
```

Open http://127.0.0.1:8081. Use an empty folder for `GATEWAY_SETUP_DIR`, and never
`C:\ProgramData\Visilant` on a computer that has a real installation.

## 5. Build the Windows bundle

The bundle must be built on a Windows x64 computer, because it ships the Windows build of
`better-sqlite3` and a `node.exe`. This is the one step that cannot be done on macOS or
Linux.

```powershell
npm.cmd ci
powershell.exe -NoProfile -File .\windows\package.ps1 `
  -DcmtkDirectory C:\Tools\dcmtk `
  -ImageMagickDirectory C:\Tools\ImageMagick
```

What the script checks before it builds, and what to do if it stops:

| Message | Cause | Fix |
|---|---|---|
| `Build with Node 22.` / `Build with Windows x64 Node.` | Wrong `node.exe` first on `PATH` | `nvm use 22`, or reinstall the 64-bit Node 22 |
| `Missing DCMTK bin\<tool>.exe` | Incomplete DCMTK folder | Extract the full DCMTK distribution; it must have a `bin` folder with all seven tools |
| `Use a portable ImageMagick distribution with magick.exe at its root.` | Installer build or wrong folder | Use the portable ZIP, extracted so that `magick.exe` is directly inside the folder |
| `ImageMagick could not read and convert a JPEG image.` | ImageMagick cannot find its coder modules | Use the portable ZIP. A copy of an installed ImageMagick fails here on purpose |
| `Repository dependencies are missing.` | `npm ci` not run in the repository root | Run `npm.cmd ci` first |
| `Use the official Node Windows archive and retain its LICENSE alongside node.exe.` | `node.exe` came from somewhere without its `LICENSE` file | Install Node from the official installer or ZIP. nvm-windows installs keep the file |

The output is `dist\windows\InSight-Gateway-<date>.zip` and a `.sha256` file beside it.
Send both. The site verifies the checksum before extracting.

The bundle's `manifest.json` records the commit it was built from and whether the working
tree was dirty. Build from a clean, committed tree so that a bundle at a site can be
traced back to the code.

**Test the bundle on a different, clean Windows computer or virtual machine**, not on the
build computer. The build computer has Node, DCMTK and ImageMagick on `PATH`, so a
problem in how the bundle finds its own tools would not show. Follow
[windows-gateway.md](windows-gateway.md#install-and-complete-setup) from the ZIP:
install, restart, firewall, phone sign-in and a synthetic screening.

## 6. Windows pitfalls, in one place

| Symptom | Cause | Fix |
|---|---|---|
| `npm` : "running scripts is disabled" | PowerShell execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` |
| `npm ci` compiles with node-gyp, or fails with a Visual Studio error | Node 24 or a 32-bit Node | Use Node 22 x64 |
| `nvm use` says "version not specified" | This nvm-windows version does not read `.nvmrc` | `nvm use 22` |
| `magick` not found, but ImageMagick is installed | The installer did not add it to `PATH`, or you only have the legacy `convert` | Use the portable ZIP and add its folder to `PATH` |
| `convert` does something strange | `convert.exe` on Windows is a disk-format tool, not ImageMagick | Always call `magick`. The gateway does |
| `TEST_DCMTK=1 npm test` is "not recognized" | Bash syntax in PowerShell | `$env:TEST_DCMTK = '1'; npm test -- --runInBand` |
| `curl` returns an HTML object or asks for parameters | PowerShell alias for `Invoke-WebRequest` | Use `Invoke-RestMethod`, or `curl.exe` |
| Docker commands hang or fail to start the archive | Docker Desktop not running, WSL 2 not installed, or virtualisation off in the BIOS | Start Docker Desktop and wait for it to say "running" |
| Port 8080 or 8081 in use | Another gateway, launcher or program | `Get-NetTCPConnection -LocalPort 8080` shows the owning process ID |
| The phone cannot reach the development gateway | Windows Firewall, or the wrong adapter's address | Allow TCP 8080 on the Private profile; use the Wi-Fi or Ethernet IPv4 address from `ipconfig` |
| Git shows every file as modified | `core.autocrlf` rewrote line endings | `git config --global core.autocrlf false`, then clone again |

## Before you push

The rules in [CONTRIBUTING.md](../CONTRIBUTING.md) apply in full:

- `npm run check` passes.
- Docs that describe what you changed are updated in the same commit.
- No patient data, `config.json`, database, `.dcm` file, log or screenshot from a site is
  in the commit.
