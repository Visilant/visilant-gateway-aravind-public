#!/usr/bin/env bash
# Git Bash entry point. Windows owns the installed task, processes and firewall rule.
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: bash windows/uninstall.sh [--apply] [--purge-data --confirm-delete-data]

Without --apply: preview only. Run Git Bash as Administrator to apply.
--apply                 Remove the installed application, task, rule and shortcut.
--purge-data            Also erase settings, accounts, logs and queued photographs.
--confirm-delete-data   Explicit acknowledgment of that permanent data deletion.

The default preserves C:\ProgramData\Visilant. No source checkout or shared tools
are removed. The script targets the standard Windows installation only.
HELP
}
apply=false
purge=false
confirm_data=false
for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --purge-data) purge=true ;;
    --confirm-delete-data) confirm_data=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done
if "$confirm_data" && ! "$purge"; then
  printf '%s\n' '--confirm-delete-data requires --purge-data.' >&2; exit 2
fi
if "$apply" && "$purge" && ! "$confirm_data"; then
  printf '%s\n' 'Data deletion requires --confirm-delete-data. This erases unsent photographs too.' >&2; exit 2
fi
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) printf '%s\n' 'Use Git Bash on the Windows gateway computer. Nothing was changed.' >&2; exit 1 ;;
esac
command -v powershell.exe >/dev/null || { printf '%s\n' 'Windows PowerShell was not found.' >&2; exit 1; }
command -v cygpath >/dev/null || { printf '%s\n' 'cygpath was not found. Run this in Git Bash.' >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
arguments=(-NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$script_dir/uninstall.ps1")")
if "$apply"; then arguments+=(-Apply); fi
if "$purge"; then arguments+=(-PurgeData); fi
if "$confirm_data"; then arguments+=(-DataDeletionConfirmation 'DELETE GATEWAY DATA'); fi
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' powershell.exe "${arguments[@]}"
