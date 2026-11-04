import { mkdtempSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { MwlNodeConfig } from '../src/config';
import { WorklistClient } from '../src/infrastructure/dicom';
import { WorklistConversionCounts } from '../src/infrastructure/dicom/WorklistClient';
import { DicomTimeoutError, ToolMissingError } from '../src/infrastructure/dicom/DicomClient';

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

    it('counts converted and malformed responses separately and cleans temporary patient files', async () => {
        const client = new WorklistClient(logger as never);
        let directory = '';
        jest.spyOn(client as unknown as { run: (bin: string, args: string[]) => Promise<string> }, 'run').mockImplementation(async (_bin, args) => {
            if (args[0] === '-W') {
                directory = args[args.length - 1];
                for (const file of ['1.dcm', '2.dcm', '3.dcm']) await fs.writeFile(path.join(directory, file), 'synthetic');
                return '';
            }
            return args[0].endsWith('1.dcm') ? '{"00100020":{"vr":"LO","Value":["CANARY"]}}' : args[0].endsWith('2.dcm') ? 'null' : 'invalid-CANARY';
        });
        let counts: WorklistConversionCounts | undefined;
        expect(await client.query(NODE, {}, value => { counts = value; })).toHaveLength(1);
        expect(counts).toEqual({ extracted_files: 3, converted_files: 3, invalid_json: 2, parsed_datasets: 1 });
        await expect(fs.access(directory)).rejects.toThrow();
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('CANARY');
    });

    it.each([
        [new DicomTimeoutError('CANARY'), 'MWL_TIMEOUT'],
        [new ToolMissingError('CANARY'), 'MWL_TOOL_UNAVAILABLE'],
        [new Error('CANARY'), 'MWL_QUERY_FAILED'],
    ])('classifies failed queries without exposing raw errors', async (error, code) => {
        const client = new WorklistClient(logger as never);
        jest.spyOn(client as unknown as { run: () => Promise<string> }, 'run').mockRejectedValue(error);
        await expect(client.query(NODE)).rejects.toMatchObject({ code, stage: 'query' });
    });

    it('converter failure aborts the query and retains partial conversion counts', async () => {
        const client = new WorklistClient(logger as never);
        let directory = '', counts: WorklistConversionCounts | undefined;
        jest.spyOn(client as unknown as { run: (bin: string, args: string[]) => Promise<string> }, 'run').mockImplementation(async (_bin, args) => {
            if (args[0] === '-W') {
                directory = args[args.length - 1];
                await fs.writeFile(path.join(directory, '1.dcm'), 'synthetic');
                await fs.writeFile(path.join(directory, '2.dcm'), 'synthetic');
                return '';
            }
            if (args[0].endsWith('1.dcm')) return '{}';
            throw new Error('CANARY');
        });
        await expect(client.query(NODE, {}, value => { counts = value; })).rejects.toMatchObject({ code: 'MWL_CONVERSION_FAILED', stage: 'conversion' });
        expect(counts).toMatchObject({ extracted_files: 2, converted_files: 1, parsed_datasets: 1 });
        await expect(fs.access(directory)).rejects.toThrow();
    });
});
