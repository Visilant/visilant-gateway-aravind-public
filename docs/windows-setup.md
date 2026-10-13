# Set up the gateway on Windows

This guide takes you from nothing to a phone that shows your worklist and sends photographs
to your PACS. Follow it from top to bottom. Every command is for **PowerShell**.

You will:

1. Install Git and Node 22.
2. Clone this repository.
3. Run one setup command. It downloads DCMTK and ImageMagick, builds the gateway, installs
   it and opens the setup wizard.
4. Fill in the wizard with your worklist and PACS details.
5. Sign in on the phone and send a test screening.

It takes about 30 minutes, most of it waiting for downloads.

## Before you start

**A Windows computer.** Windows 10 or 11, 64-bit, with administrator rights. It must be on
the same network as the phone and able to reach the worklist and PACS servers.

**The phone.** The InSight-Gateway app (APK) is already installed on it. Nothing on the
phone changes.

**From whoever runs your worklist and PACS** (write these down before you open the wizard):

| You need | Example | Notes |
|---|---|---|
| Worklist server address and port | `10.1.2.3`, `104` | The server that lists scheduled patients (DICOM Modality Worklist) |
| Worklist AE title | `FREEDOM_MWL` | Its DICOM name. Capitals matter |
| PACS server address and port | `10.1.2.4`, `11112` | The image archive |
| PACS AE title | `DCM4CHEE` | |
| How orders for this device are marked | station `VISILANT` | So the phone shows only its own patients. See [worklist.md](worklist.md#the-three-filters) |
| A test (made-up) patient order | | For the final test. Never use a real patient |

**Ask them to register the gateway** on both servers: AE title `VISILANT` with this
computer's IP address, and permission to **store** images on the PACS. Without this the
connection test in the wizard fails with "Calling AE Title Not Recognized".

## Step 1: install Git and Node 22

Skip anything you already have.

1. **Git for Windows**: https://git-scm.com/download/win. Keep the default options.
2. **Node 22, 64-bit.** The gateway works **only** with Node 22. Node 24 does not work.
   - If you use **nvm-windows**, type the version; it does not read `.nvmrc`:
     ```powershell
     nvm install 22
     nvm use 22
     ```
   - Otherwise install "22.x LTS, Windows Installer (.msi), x64" from https://nodejs.org.

Close PowerShell, open a **new** PowerShell window, and check:

```powershell
node -v
```

It must print `v22.` followed by numbers. If it prints `v24` or something else, run
`nvm use 22` again.

## Step 2: clone the repository

```powershell
cd $HOME
git clone https://github.com/Visilant/visilant-gateway-aravind-public.git
cd visilant-gateway-aravind-public
```

## Step 3: run the setup command

In the same window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1
```

What it does, in order. Each step prints a line starting with `==`:

| Step | What happens |
|---|---|
| Checking this computer | Checks 64-bit Windows, Git and Node 22. If one is wrong it stops and says exactly what to do |
| DCMTK and ImageMagick | Downloads them once into `C:\Tools\dcmtk` and `C:\Tools\ImageMagick`, checks that the files are the expected ones, and adds them to your `PATH` |
| Installing dependencies | `npm ci` |
| Building the Windows bundle | Builds a self-contained copy of the gateway in `dist\windows\` |
| Installing the gateway | Windows asks for **administrator permission: click Yes**. The gateway is installed in `C:\Program Files\Visilant\InSight-Gateway`, set to start with Windows, and allowed through the firewall |

At the end your browser opens the **setup wizard** at http://127.0.0.1:8081. There is also
a **Gateway Setup** shortcut on the desktop.

If the command stops with a red message, fix what it says and run the same command again.
Steps that already finished are skipped.

## Step 4: the setup wizard

The wizard has five steps. It saves as you go: you can close the browser and come back
through the desktop shortcut.

### 1. This computer

Click **Check this computer**. Every row must say **Ready**. It checks the DICOM tools,
ImageMagick (it converts a real JPEG), free disk space and the gateway port.

### 2. Hospital connections

The page title says "Connect to Aravind" and some boxes are already filled in. These are
starting values. Change them to match your servers.

| Box | What to enter |
|---|---|
| Centre code | A short name for this site, for example `ARAVIND` or `ARAVIND_TEST` |
| Gateway port | `8080`. Leave it unless something else on this computer uses 8080 |
| **Patient worklist**: Server address, Server port, Hospital AE title | The worklist details from the table above |
| Gateway AE title | `VISILANT`. This must match what was registered on the server |
| **Image archive (PACS)**: Server address, Server port, Hospital AE title | The PACS details from the table above |
| Gateway AE title | `VISILANT` |
| Procedure ID (optional) | Leave empty unless every order for this device has the same procedure ID |
| Approved DICOM UID root | Leave as it is (`1.2.826.0.1.3680043.10.1338`, Visilant's) |
| Advanced settings → Station filter | The station AE title your orders are scheduled to, usually `VISILANT`. This is the best way to show the phone only its own patients |
| Advanced settings → Modality filter | Usually empty. `OP` would also match fundus camera orders |

Click **Save & test connections**. The gateway sends a DICOM "echo" to each server. Both
rows must say **Ready**. If one fails, the message says why; the table in
[troubleshooting.md](troubleshooting.md#connection-test-fails-in-the-setup-wizard) lists
the causes. Fix the details and test again.

> Once you finish the next step, these settings can no longer be changed in the wizard.
> Check them now. To change them later, see [Change settings later](#change-settings-later).

### 3. Operator account

Enter an account name, an email and a password of at least 12 characters, then **Save &
start gateway**. This is the account you sign in with on the phone, and it can also manage
the gateway. Keep the password somewhere safe; it is not shown again.

### 4. Connect the phone

The wizard shows this computer's **gateway address** (for example `192.168.1.20:8080`).

On the phone, open **InSight-Gateway**:

1. Enter the gateway address shown in the wizard. Never use `localhost` on the phone.
2. Sign in with the account from step 3.
3. Open **Patients to Screen** and refresh it. Your test order should appear.

The wizard ticks **Network sign-in** and **Worklist fetched** when it sees the phone. If
more than one address is shown, ask your network team which one the phone can reach.

### 5. Test & finish

1. Photograph the **test** patient on the phone and submit the screening.
2. Wait until the wizard shows the images as **accepted by PACS**.
3. Open the study in your PACS viewer and check that the images are there, on the right
   patient and eye.
4. **Restart the computer.** Open **Gateway Setup** from the desktop again and check that
   the phone still connects. The wizard notices the restart.
5. Tick the three boxes and click **Finish setup**.

From now on the wizard opens a status page with a link to the operator dashboard
(http://127.0.0.1:8080/ui). Sign in there with the same account to see queued, sent and
failed images.

## If something goes wrong

| What you see | What to do |
|---|---|
| `npm` or the script: "running scripts is disabled on this system" | Use the exact command from Step 3; it includes `-ExecutionPolicy Bypass`. For `npm` itself, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once |
| "Node 24... the gateway needs Node 22" | `nvm install 22`, `nvm use 22`, open a new window, run the setup command again |
| `npm ci` prints `node-gyp`, `MSBuild` or "Visual Studio" | The wrong Node is active. Same fix as above |
| "Could not download..." | Check the internet connection or proxy. Downloads are needed only once |
| Administrator prompt was cancelled | Run the setup command again and click **Yes** |
| Wizard page does not open | Open http://127.0.0.1:8081 yourself, or use the desktop shortcut |
| Connection test fails | [troubleshooting.md](troubleshooting.md#connection-test-fails-in-the-setup-wizard) |
| Phone cannot reach the gateway | [troubleshooting.md](troubleshooting.md#the-phone-cannot-reach-the-gateway) |
| Phone shows no patients, or too many | [troubleshooting.md](troubleshooting.md#the-phone-shows-no-patients-or-the-wrong-patients) |
| Images do not reach the PACS | [troubleshooting.md](troubleshooting.md#c-echo-works-but-images-do-not-reach-the-pacs) |

The logs are in `C:\ProgramData\Visilant\logs` (open them as administrator).
[troubleshooting.md](troubleshooting.md) explains what to look for.

**Never delete `C:\ProgramData\Visilant`** to start again. It holds the settings, the
accounts and every photograph that has not reached the PACS yet.

## Change settings later

After the account is created the wizard locks the settings. To change them, for example to
move from a test PACS to the real one:

1. Open Notepad **as administrator** and open `C:\ProgramData\Visilant\config.json`.
2. Change the values. The names are explained in [configuration.md](configuration.md).
3. Save and restart the computer.

If the gateway does not come back, the reason (for example a misspelt setting name) is in
`C:\ProgramData\Visilant\logs\launcher.log`.

## Update the gateway

Running the setup command again on a computer where the gateway is installed **does not
update it**. It only reopens the wizard, so that a working site is never overwritten by
accident. To update an installed gateway, follow
[troubleshooting.md](troubleshooting.md#updating-an-installed-gateway).

## Start again on a test computer

Only on a **test** computer that has only ever seen made-up patients. **Never on a gateway
at a hospital:** this deletes its settings, accounts and every photograph not yet in the
PACS.

The setup command never replaces an installed gateway. To install again from nothing,
remove the old one first. In PowerShell **as administrator**:

```powershell
Stop-ScheduledTask -TaskName 'Visilant InSight-Gateway' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Visilant InSight-Gateway' -Confirm:$false -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$env:ProgramFiles\Visilant\*" } | Stop-Process -Force
Remove-NetFirewallRule -DisplayName 'Visilant InSight-Gateway' -ErrorAction SilentlyContinue
Remove-Item "$env:ProgramFiles\Visilant", "$env:ProgramData\Visilant" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:PUBLIC\Desktop\Gateway Setup.url" -Force -ErrorAction SilentlyContinue
```

Then run the setup command from Step 3 again.

## Next

- To understand how the gateway works and how to change it, read
  [docs/README.md](README.md). It lists the documents in the order to read them.
- To change the code and run the tests, see [development.md](development.md).
