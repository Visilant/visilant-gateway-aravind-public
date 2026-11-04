import { WorklistService } from '../src/application/services/WorklistService';
import { WorklistInspection, WORKLIST_INSPECTION_LIMITS } from '../src/application/services/WorklistInspection';
import { WorklistDiagnosticsService } from '../src/application/services/WorklistDiagnosticsService';
import { WorklistQueryError } from '../src/infrastructure/dicom/WorklistClient';
import { diagnostics } from '../src/infrastructure/diagnostics';
import type { GatewayConfig } from '../src/config';
import type { DicomJsonDataset } from '../src/infrastructure/dicom';

const config = { study_uid_root: '1.2.826.0.1.3680043.10.1338',
    mwl: { host: 'synthetic', port: 104, called_ae: 'TEST_MWL', calling_ae: 'VISILANT', scheduled_station_ae: 'ANTERIOR' } } as GatewayConfig;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const row = (accession: string): DicomJsonDataset => ({
    '00080050': { vr: 'SH', Value: [accession] }, '00100020': { vr: 'LO', Value: ['CANARY-PATIENT'] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'CANARY^NAME', Ideographic: 'SYNTHETIC' }] },
    '00321060': { vr: 'LO', Value: ['Anterior_Segment_Image'] },
    '00400100': { vr: 'SQ', Value: [{ '00400009': { vr: 'SH', Value: ['STEP-1'] }, '00400001': { vr: 'AE', Value: ['ANTERIOR'] } }, {}] },
});

test('shows rejected raw datasets, exact strings and received versus derived UIDs without changing clinical mapping', async () => {
    const rows = [row(''), row('00098'), { ...row(' 98 '), '0020000D': { vr: 'UI', Value: ['1.2.3.4.5'] } }];
    const filter = jest.fn(async (entries, _reconcile: boolean) => entries);
    const client = { query: jest.fn().mockResolvedValue(rows) };
    const svc = new WorklistService(config, logger as never, client as never, { filter } as never);
    const event = jest.spyOn(diagnostics, 'event');
    try {
        const result = await svc.inspect();
        expect(result.query).toEqual({ ...config.mwl, requested_procedure_id: '', modality: '' });
        expect(result.check).toMatchObject({ source: 'gateway_probe', counts: { missing_accession: 2, returned_rows: 4 } });
        expect(result.records.map(r => JSON.parse(r.dicom_json))).toEqual(rows);
        expect(result.records[0].candidates).toEqual([1, 2].map(step_index => ({ step_index, outcome: 'missing_accession', effective_study_uid: null, study_uid_source: 'not_mapped' })));
        expect(result.records[1].candidates[0]).toMatchObject({ outcome: 'accepted', study_uid_source: 'derived', effective_study_uid: expect.stringMatching(/^1\.2\.826\./) });
        expect(result.records[2].candidates[0]).toMatchObject({ effective_study_uid: '1.2.3.4.5', study_uid_source: 'received' });
        expect(filter.mock.calls[0][1]).toBe(false);
        const report = new WorklistDiagnosticsService(svc, { status: () => ({ enabled: true }) } as never).report();
        expect(JSON.stringify([report, event.mock.calls, logger.warn.mock.calls])).not.toMatch(/CANARY|Anterior_Segment_Image|00098|1\.2\.3\.4\.5/);
        expect(report.checks[0]).not.toHaveProperty('records');
        expect((await svc.getWorklist()).map(e => e.accession_number)).toEqual(['00098', '00098', '98', '98']);
        expect(filter.mock.calls[1][1]).toBe(true);
    } finally { event.mockRestore(); }
});

test('retains already converted records when a later conversion fails, without claiming mapping succeeded', async () => {
    const client = { query: async (_node: unknown, _query: unknown, count: Function, inspect: Function) => {
        inspect(row(''), 1);
        count({ extracted_files: 2, converted_files: 1, parsed_datasets: 1, invalid_json: 0 });
        throw new WorklistQueryError('MWL_CONVERSION_FAILED', 'conversion');
    } };
    const filter = jest.fn();
    const svc = new WorklistService(config, logger as never, client as never, { filter } as never);
    const result = await svc.inspect();
    expect(result.check).toMatchObject({ outcome: 'failed', stage: 'conversion', counts: { returned_rows: null } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].candidates).toEqual([]);
    expect(filter).not.toHaveBeenCalled();
});

test('inspection shares the probe lock and keeps parallel ordinary requests out of the private response', async () => {
    let finish!: (rows: DicomJsonDataset[]) => void;
    const client = { query: jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue([row('OTHER')]) };
    const svc = new WorklistService(config, logger as never, client as never, { filter: async (rows: unknown) => rows } as never);
    const pending = svc.inspect();
    await expect(svc.inspect()).rejects.toThrow('already running');
    await expect(svc.probe()).rejects.toThrow('already running');
    await svc.getWorklist(); finish([row('00098')]);
    const result = await pending;
    expect(JSON.stringify(result.records)).not.toContain('OTHER');
    expect(JSON.stringify(result.records)).toContain('00098');
    expect((await svc.inspect()).records[0].dicom_json).toContain('OTHER');
});

test('omits whole oversized records and caps record count without truncating identifiers', () => {
    const view = new WorklistInspection();
    view.receive({ '00100020': { vr: 'LO', Value: ['A'.repeat(WORKLIST_INSPECTION_LIMITS.record_bytes)] } }, 1);
    for (let i = 2; i <= 103; i++) view.receive(row('00098'), i);
    const result = view.snapshot();
    expect(result).toMatchObject({ parsed_datasets_observed: 103, omitted_records: 3 });
    expect(result.records).toHaveLength(100);
    expect(result.records[0].dataset_index).toBe(2);
    expect(JSON.parse(result.records[0].dicom_json)['00080050'].Value).toEqual(['00098']);
});

test('bounds raw bytes and candidate details together', () => {
    const view = new WorklistInspection();
    for (let i = 1; i <= 100; i++) view.receive({ '00100020': { vr: 'LO', Value: ['A'.repeat(30000)] } }, i);
    expect(view.snapshot().omitted_records).toBeGreaterThan(0);
    for (let i = 0; i < 2000; i++) view.candidate(1, i + 1, { study_instance_uid: '1'.repeat(1000) } as never, true, true, true);
    const result = view.snapshot();
    expect(result.omitted_candidate_details).toBeGreaterThan(0);
    const bytes = result.records.reduce((total, record) => total + Buffer.byteLength(record.dicom_json)
        + record.candidates.reduce((sum, candidate) => sum + Buffer.byteLength(JSON.stringify(candidate)), 0), 0);
    expect(bytes).toBeLessThanOrEqual(WORKLIST_INSPECTION_LIMITS.total_bytes);
});
