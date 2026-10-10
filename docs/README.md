# Documentation

Each document describes the gateway as it is now. When you change behaviour, a script or a
config key, update the document that describes it in the same change.

## Understand the system

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | Layers, the life of a worklist request and of a photograph, where each thing lives in `src/` |
| [worklist.md](worklist.md) | The DICOM worklist query: which tags are sent, how procedure ID, modality and station filters work, how to change them |
| [dicom-output.md](dicom-output.md) | The DICOM object the gateway builds, UIDs, series, coded values, the AI private tag, and delivery to the PACS |

## Develop

| Document | What it covers |
|---|---|
| [development.md](development.md) | Local setup, the test PACS, tests, end-to-end run, migrations, and step-by-step recipes for common changes |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Coding rules: layering, validation, migrations, patient data |
| [api.md](api.md) | HTTP API used by the phone and the operator page |
| [configuration.md](configuration.md) | Every `config.json` key and environment variable |

## Install and operate

| Document | What it covers |
|---|---|
| [windows-gateway.md](windows-gateway.md) | The Windows bundle, the one-time setup wizard, building the bundle |
| [troubleshooting.md](troubleshooting.md) | Symptoms, causes and fixes, with the commands to run on the Windows computer |
| [aravind-deployment.md](aravind-deployment.md) | How the Aravind installation is configured, and what is still open there |
