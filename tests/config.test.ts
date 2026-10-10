import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadConfig } from '../src/config';

const VALID = {
    centre_code: 'ARAVIND_XX',
    listen_port: 8080,
    storage_root: '/tmp/captures',
    database_path: '/tmp/gateway.db',
    retention: 'DELETE_ON_SENT',
    study_uid_root: '1.2.826.0.1.3680043.10.1338',
    mwl: { host: '10.0.0.10', port: 104, called_ae: 'RIS_MWL', calling_ae: 'VISILANT' },
    store: { host: '10.0.0.11', port: 104, called_ae: 'DCM4CHEE', calling_ae: 'VISILANT' },
};

function writeConfig(body: unknown): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-config-'));
    const file = path.join(dir, 'config.json');
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
}

describe('loadConfig', () => {
    it('loads a valid config', () => {
        const config = loadConfig(writeConfig(VALID));
        expect(config.centre_code).toBe('ARAVIND_XX');
        expect(config.mwl.called_ae).toBe('RIS_MWL');
        expect(config.store.called_ae).toBe('DCM4CHEE');
    });

    // MWL and archive are separate nodes on purpose; the schema must not let one
    // stand in for the other. @ValidateNested passes on an absent property, so presence
    // needs its own check, or the gateway starts and fails at the first association.
    it.each(['mwl', 'store'])('rejects a config missing the %s DICOM node', (node) => {
        const { [node]: _node, ...without } = VALID as Record<string, unknown>;
        expect(() => loadConfig(writeConfig(without))).toThrow(new RegExp(node));
    });

    it('rejects an AE title longer than the DICOM limit of 16', () => {
        const tooLong = { ...VALID, store: { ...VALID.store, called_ae: 'A'.repeat(17) } };
        expect(() => loadConfig(writeConfig(tooLong))).toThrow(/store.called_ae/);
    });

    it('names the file when it is missing', () => {
        expect(() => loadConfig('/nonexistent/config.json')).toThrow(/Could not read gateway config/);
    });

    it('names the file when the JSON is malformed', () => {
        expect(() => loadConfig(writeConfig('{ not json'))).toThrow(/not valid JSON/);
    });

    // A typo'd key that silently does nothing is the worst failure mode for a file
    // someone edits by hand on a machine with no feedback loop.
    it('rejects an unknown key rather than ignoring it', () => {
        const typo = { ...VALID, storeage_root: '/tmp/x' };
        expect(() => loadConfig(writeConfig(typo))).toThrow(/storeage_root/);
    });

    it('accepts the worklist procedure ID filter', () => {
        const config = loadConfig(writeConfig({ ...VALID, mwl: { ...VALID.mwl, requested_procedure_id: 'ASI01' } }));
        expect(config.mwl.requested_procedure_id).toBe('ASI01');
    });

    // (0040,1001) is an SH: longer than 16 and the RIS rejects the query.
    it('rejects a procedure ID longer than the DICOM limit of 16', () => {
        const tooLong = { ...VALID, mwl: { ...VALID.mwl, requested_procedure_id: 'P'.repeat(17) } };
        expect(() => loadConfig(writeConfig(tooLong))).toThrow(/mwl.requested_procedure_id/);
    });

    it('sends captures immediately by default', () => {
        expect(loadConfig(writeConfig(VALID)).send_immediately).toBe(true);
        expect(loadConfig(writeConfig({ ...VALID, send_immediately: false })).send_immediately).toBe(false);
    });

    it('defaults the listen port', () => {
        const { listen_port: _p, ...minimal } = VALID;
        const config = loadConfig(writeConfig(minimal));
        expect(config.listen_port).toBe(8080);
    });

    describe('retention', () => {
        it('defaults retention to KEEP and retention_keep_count to 10', () => {
            const { retention: _retention, ...withoutRetention } = VALID;
            const config = loadConfig(writeConfig(withoutRetention));
            expect(config.retention).toBe('KEEP');
            expect(config.retention_keep_count).toBe(10);
        });

        it('still accepts DELETE_ON_SENT', () => {
            expect(loadConfig(writeConfig({ ...VALID, retention: 'DELETE_ON_SENT' })).retention).toBe('DELETE_ON_SENT');
        });

        it('rejects a non-positive or non-integer retention_keep_count, naming the key', () => {
            for (const retention_keep_count of [0, -1, 1.5, 'ten']) expect(() => loadConfig(writeConfig({ ...VALID, retention_keep_count }))).toThrow(/retention_keep_count/);
        });
    });
});
