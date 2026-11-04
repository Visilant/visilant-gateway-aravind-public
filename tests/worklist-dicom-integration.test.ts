import { execFile, spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { createServer, AddressInfo } from 'net';
import { GatewayConfig } from '../src/config';
import { WorklistClient } from '../src/infrastructure/dicom';
import { WorklistService } from '../src/application/services/WorklistService';

const run = promisify(execFile);
const integration = process.env.TEST_DCMTK === '1' ? describe : describe.skip;
integration('worklist diagnostics over real C-FIND', () => {
    let root: string, process: ChildProcess, service: WorklistService;
    beforeAll(async () => {
        root = await fs.mkdtemp(path.join(tmpdir(), 'gw-worklist-integration-'));
        const spool = path.join(root, 'TEST_MWL'); await fs.mkdir(spool);
        await fs.writeFile(path.join(spool, 'lockfile'), '');
        for (const [index, accession] of ['', '00098'].entries()) {
            const dump = path.join(root, `${index}.dump`);
            await fs.writeFile(dump, `(0008,0050) SH [${accession}]
(0010,0010) PN [SYNTHETIC^ONLY]
(0010,0020) LO [TEST-${index}]
(0020,000d) UI [1.2.826.0.1.3680043.10.1338.99.${index + 1}]
(0032,1060) LO [Anterior_Segment_Image]
(0040,1001) SH [TEST-PROC]
(0040,0100) SQ
(fffe,e000) na
(0008,0060) CS [OP]
(0040,0001) AE [VISILANT]
(0040,0002) DA [20261104]
(0040,0003) TM [120000]
(0040,0007) LO [Anterior_Segment_Image]
(0040,0009) SH [STEP-${index}]
(fffe,e00d) na
(fffe,e0dd) na
`);
            await run('dump2dcm', [dump, path.join(spool, `${index}.wl`)]);
        }
        const socket = createServer();
        await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
        const port = (socket.address() as AddressInfo).port;
        await new Promise<void>(resolve => socket.close(() => resolve()));
        process = spawn('wlmscpfs', ['-s', '-q', '-dfr', '-dfp', root, String(port)], { stdio: 'ignore' });
        let startupError: Error | undefined;
        process.on('error', error => { startupError = error; });
        let ready = false;
        for (let i = 0; i < 30; i++) {
            if (startupError) throw startupError;
            try { await run('echoscu', ['127.0.0.1', String(port), '-aec', 'TEST_MWL'], { timeout: 1000 }); ready = true; break; }
            catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        if (!ready) throw new Error('Synthetic MWL server did not start');
        const config = Object.assign(new GatewayConfig(), { study_uid_root: '1.2.826.0.1.3680043.10.1338',
            mwl: { host: '127.0.0.1', port, calling_ae: 'VISILANT', called_ae: 'TEST_MWL', scheduled_station_ae: 'VISILANT' } });
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        service = new WorklistService(config, logger as never, new WorklistClient(logger as never), { filter: async (entries: unknown) => entries } as never);
    }, 15000);
    afterAll(async () => {
        if (process && process.exitCode === null && process.pid) {
            const exited = new Promise<void>(resolve => process.once('exit', () => resolve()));
            process.kill(); await exited;
        }
        if (root) await fs.rm(root, { recursive: true, force: true });
    });
    test('explains the blank accession and preserves a leading-zero order ID', async () => {
        const inspected = await service.inspect();
        expect(inspected.records).toHaveLength(2);
        expect(inspected.omitted_records).toBe(0);
        const incoming = inspected.records.map(record => JSON.parse(record.dicom_json));
        expect(incoming.map(dataset => dataset['00100020'].Value[0]).sort()).toEqual(['TEST-0', 'TEST-1']);
        expect(incoming.some(dataset => dataset['00080050'].Value?.[0] === '00098')).toBe(true);
        expect(inspected.records.flatMap(record => record.candidates).map(candidate => candidate.outcome).sort()).toEqual(['accepted', 'missing_accession']);
        const entries = await service.getWorklist();
        expect(entries.map(entry => entry.accession_number)).toEqual(['00098']);
        expect(service.recent()[0].counts).toMatchObject({ extracted_files: 2, converted_files: 2, parsed_datasets: 2,
            candidate_rows: 2, missing_accession: 1, accepted_rows: 1, rejected_rows: 1, returned_rows: 1 });
        const absent = await service.probe({ requested_procedure_id: '', modality: '', scheduled_station_ae: 'OTHER_STATION' });
        expect(absent).toMatchObject({ outcome: 'no_matches', counts: { extracted_files: 0, returned_rows: 0 } });
        expect((await service.getWorklist()).map(entry => entry.accession_number)).toEqual(['00098']);
    }, 20000);
});
