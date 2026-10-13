# Documentation

Each document describes the gateway as it is now. When you change behaviour, a script or a
config key, update the document that describes it in the same change.

## Read in this order

You don't need to read everything at once. Read in this order as you get to know the system.

### First day: get it running

| Read | So that you can |
|---|---|
| [windows-setup.md](windows-setup.md) | Install the gateway, fill in the setup wizard, connect the phone, send a test screening |
| [troubleshooting.md](troubleshooting.md) | Find the logs, read `/health`, fix the common problems |

### First week: understand what it does

| Read | What you learn |
|---|---|
| [architecture.md](architecture.md) | The big picture, the folder map, what happens to a worklist request and to a photograph, the capture states (`PENDING`, `SENDING`, `SENT`, `FAILED`) |
| [worklist.md](worklist.md) | How the gateway asks your worklist server for patients, and the **three filters** that decide which patients the phone sees. This is the most common thing to change at a site |
| [dicom-output.md](dicom-output.md) | What goes into each DICOM file, how UIDs and series are made, and how files reach the PACS with retries |
| [configuration.md](configuration.md) | Every setting in `config.json` |

### Before you change code

| Read | Why |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | The rules for this code. The most important ones are below |
| [development.md](development.md) | Run from source, the tests, a local test PACS, database migrations, and step-by-step recipes for common changes |
| [api.md](api.md) | The HTTP API the phone uses. The phone app is not in this repository, so this is a contract: do not break it |

### Reference

| Read | When |
|---|---|
| [windows-gateway.md](windows-gateway.md) | Details of the installer: the startup task, the firewall rule, resuming setup, logs, the support report. It is also the README inside the bundle ZIP |
| [aravind-deployment.md](aravind-deployment.md) | How the Aravind installation is configured, and what is still open before go-live |

## Six things every developer must know

These matter more than anything else here. Each one has caused or would cause a real
problem at a site.

1. **Patient data never goes into the database, the logs or Git.** It lives only in the
   `.dcm` files on disk. Use only made-up test patients. Never commit `config.json`, a
   database, a `.dcm` file, a log or a screenshot from a site.
   [CONTRIBUTING.md](../CONTRIBUTING.md#patient-data-phi)
2. **The gateway computer runs with nobody watching.** Expect power cuts and a PACS that
   is down for hours. Anything important is saved in SQLite, a local file is never deleted
   before the PACS confirms it, and every error message must say what failed and what to
   do. [architecture.md](architecture.md#built-for-an-unattended-computer)
3. **Never delete `C:\ProgramData\Visilant`.** It holds the settings, the accounts and
   every photograph not yet in the PACS. [troubleshooting.md](troubleshooting.md#where-to-look-first)
4. **Database changes: change the entity, then generate the migration.** Never write a
   migration by hand. Migrations run by themselves at every gateway's start-up.
   [development.md](development.md#4-database-changes)
5. **The phone depends on the API.** Unknown fields are rejected, so a new field must be
   added to the gateway (as optional) and installed **before** any phone sends it. Never
   remove or rename a field the phone uses.
   [CONTRIBUTING.md](../CONTRIBUTING.md#contract-with-the-capture-app)
6. **Code layers: controller → service → repository.** Controllers only handle HTTP,
   services hold the logic, repositories only read and write the database.
   [CONTRIBUTING.md](../CONTRIBUTING.md#layering-controller--service--repository)
