import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// All Windows commands are fakes. These tests never touch an installed gateway.
const bashTests = process.platform === 'win32' ? describe.skip : describe;
bashTests('Windows uninstall Bash entry point', () => {
    let root: string, script: string, capture: string;
    beforeAll(() => {
        root = mkdtempSync(path.join(tmpdir(), 'gateway uninstall tests '));
        script = path.join(root, 'uninstall.sh'); capture = path.join(root, 'arguments');
        copyFileSync(path.join(__dirname, '../windows/uninstall.sh'), script);
        for (const [name, content] of Object.entries({
            uname: '#!/bin/sh\nprintf MINGW64_NT\n',
            cygpath: '#!/bin/sh\nprintf "%s" "$2"\n',
            'powershell.exe': '#!/bin/sh\nprintf "%s\\n" "$@" > "$GW_TEST_CAPTURE"\nexit "${GW_TEST_EXIT_CODE:-0}"\n',
        })) writeFileSync(path.join(root, name), content, { mode: 0o755 });
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    function invoke(args: string[], code = '0') {
        rmSync(capture, { force: true });
        return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GW_TEST_CAPTURE: capture, GW_TEST_EXIT_CODE: code } });
    }
    test('defaults to preview and preserves paths containing spaces as one argument', () => {
        expect(invoke([]).status).toBe(0);
        const args = readFileSync(capture, 'utf8').trim().split('\n');
        expect(args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'uninstall.ps1')]);
    });
    test('requires explicit data-deletion acknowledgment before invoking PowerShell', () => {
        expect(invoke(['--apply', '--purge-data']).status).toBe(2);
        expect(() => readFileSync(capture)).toThrow();
        expect(invoke(['--apply', '--purge-data', '--confirm-delete-data']).status).toBe(0);
        expect(readFileSync(capture, 'utf8')).toContain('-DataDeletionConfirmation\nDELETE GATEWAY DATA');
    });
    test('rejects unknown options and propagates failures', () => {
        expect(invoke(['--delete-everything']).status).toBe(2);
        expect(invoke(['--apply'], '7').status).toBe(7);
        expect(readFileSync(capture, 'utf8')).not.toContain('-PurgeData');
    });
});
