import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { MwlNodeConfig } from '../src/config';
import { WorklistClient } from '../src/infrastructure/dicom';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const NODE: MwlNodeConfig = {
    host: 'mwl', port: 11112, called_ae: 'WORKLIST', calling_ae: 'VISILANT',
    requested_procedure_id: 'ASI01',
};

// Captures the findscu argv instead of running it.
function capture(node: MwlNodeConfig, query = {}) {
    const client = new WorklistClient(logger as never);
    const run = jest.spyOn(client as never as { run: () => Promise<string> }, 'run').mockResolvedValue('');
    jest.spyOn(require('fs').promises, 'mkdtemp').mockResolvedValue(mkdtempSync(path.join(tmpdir(), 'mwl-')));
    return client.query(node, query).then(() => (run.mock.calls[0] as unknown as [string, string[]])[1]);
}

describe('WorklistClient', () => {
    afterEach(() => jest.restoreAllMocks());

    // The pilot filtered the worklist on Requested Procedure ID and nothing else.
    it('matches on the configured Requested Procedure ID', async () => {
        const args = await capture(NODE);
        expect(args).toContain('0040,1001=ASI01');
        expect(args).toContain('-W');
        expect(args.slice(0, 7)).toEqual(['-W', 'mwl', '11112', '-aec', 'WORKLIST', '-aet', 'VISILANT']);
    });

    it('sends the procedure ID as a bare return key when none is configured', async () => {
        const args = await capture({ ...NODE, requested_procedure_id: undefined });
        expect(args).toContain('0040,1001');
        expect(args.some((a) => a.startsWith('0040,1001='))).toBe(false);
    });

    it('adds the date only when one is asked for', async () => {
        const without = await capture(NODE);
        expect(without.some((a) => a.includes('0040,0002='))).toBe(false);

        const withDate = await capture(NODE, { scheduledDate: '20260101' });
        expect(withDate.some((a) => a.endsWith('0040,0002=20260101'))).toBe(true);
    });
});
