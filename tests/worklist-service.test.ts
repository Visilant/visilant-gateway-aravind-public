import type { GatewayConfig } from '../src/config';
import { DicomJsonDataset } from '../src/infrastructure/dicom';
import { WorklistService } from '../src/application/services/WorklistService';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const config = {
    study_uid_root: '1.2.826.0.1.3680043.10.1338',
    mwl: { host: 'h', port: 104, called_ae: 'W', calling_ae: 'V' },
} as GatewayConfig;

function service(datasets: DicomJsonDataset[]) {
    const client = { query: jest.fn().mockResolvedValue(datasets) };
    const svc = new WorklistService(config, logger as never, client as never, { filter: async (entries: unknown) => entries } as never);
    return { svc, client };
}

const FULL: DicomJsonDataset = {
    '00080050': { vr: 'SH', Value: ['ACC001'] },
    '00080090': { vr: 'PN', Value: [{ Alphabetic: 'NATARAJAN^SURESH' }] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DEVI^MEENAKSHI' }] },
    '00100020': { vr: 'LO', Value: ['MRN100991'] },
    '00100030': { vr: 'DA', Value: ['19640127'] },
    '00100040': { vr: 'CS', Value: ['F'] },
    '0020000D': { vr: 'UI', Value: ['1.2.3.4.5'] },
    '00321060': { vr: 'LO', Value: ['Diabetic Retinopathy Screening'] },
    '00401001': { vr: 'SH', Value: ['RP001'] },
    '00400100': {
        vr: 'SQ',
        Value: [{
            '00080060': { vr: 'CS', Value: ['OP'] },
            '00400002': { vr: 'DA', Value: ['20260914'] },
            '00400003': { vr: 'TM', Value: ['093000'] },
            '00400009': { vr: 'SH', Value: ['SPS001'] },
        }],
    },
};

describe('WorklistService', () => {
    it('maps a full worklist response', async () => {
        const { svc } = service([FULL]);
        const [entry] = await svc.getWorklist({});

        expect(entry.accession_number).toBe('ACC001');
        // Straight from the RIS, never derived — an image under any other Study UID
        // lands in a study nobody ordered.
        expect(entry.study_instance_uid).toBe('1.2.3.4.5');
        // Person Name stays DICOM-native so it round-trips byte-for-byte into the object.
        expect(entry.patient_name).toBe('DEVI^MEENAKSHI');
        expect(entry.patient_birth_date).toBe('19640127');
        expect(entry.scheduled?.modality).toBe('OP');
        expect(entry.scheduled?.step_id).toBe('SPS001');
    });

    // The pilot never filtered by date: the MWL holds open orders only, and a today-only
    // default would hide yesterday's order for the patient sitting at the camera now.
    it('does not filter by date unless asked to', async () => {
        const { svc, client } = service([]);
        await svc.getWorklist({});
        expect(client.query.mock.calls[0][1].scheduledDate).toBeUndefined();
    });

    it('passes an explicit date through', async () => {
        const { svc, client } = service([]);
        await svc.getWorklist({ date: '20260101-20260131' });
        expect(client.query.mock.calls[0][1].scheduledDate).toBe('20260101-20260131');
    });

    // An entry without these cannot be captured against, so surfacing it would only
    // produce a row in the app that fails at the moment someone takes the photograph.
    it.each([
        ['accession number', '00080050'],
        ['patient ID', '00100020'],
    ])('drops an entry missing its %s', async (_label, tag) => {
        const incomplete = { ...FULL };
        delete incomplete[tag];
        const { svc } = service([incomplete, FULL]);

        const entries = await svc.getWorklist({});
        expect(entries).toHaveLength(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipped 1'));
        // The contents are PHI; the log may say how many, never which.
        const logged = logger.warn.mock.calls.map((c) => String(c[0])).join(' ');
        expect(logged).not.toMatch(/DEVI|MEENAKSHI|MRN100991/);
    });

    // Only when the RIS sends none: then every capture for the order must still land in
    // one study, so the UID is derived from the accession rather than made up per image.
    it('derives a stable Study UID from the accession when the RIS sends none', async () => {
        const noUid = { ...FULL };
        delete noUid['0020000D'];
        const { svc } = service([noUid, noUid]);
        const [first, second] = await svc.getWorklist({});

        expect(first.study_instance_uid).toMatch(/^1\.2\.826\.0\.1\.3680043\.10\.1338\.\d+$/);
        expect(first.study_instance_uid.length).toBeLessThanOrEqual(64);
        expect(second.study_instance_uid).toBe(first.study_instance_uid);
    });

    // Patient Name is Type 2: an order without one is still capturable, and the name is
    // left empty in the object rather than invented.
    it('keeps an entry with no patient name, without inventing one', async () => {
        const noName = { ...FULL };
        delete noName['00100010'];
        const { svc } = service([noName]);
        const [entry] = await svc.getWorklist({});

        expect(entry.accession_number).toBe('ACC001');
        expect('patient_name' in JSON.parse(JSON.stringify(entry))).toBe(false);
    });

    it.each([
        ['m', 'M'], ['FEMALE', 'O'], ['U', 'O'], ['', undefined],
    ])('normalises patient sex %j to %j', async (input, expected) => {
        const { svc } = service([{ ...FULL, '00100040': { vr: 'CS', Value: [input] } }]);
        const [entry] = await svc.getWorklist({});
        expect(entry.patient_sex).toBe(expected);
    });

    // What matters is the wire format the app receives. Declared class fields exist
    // as undefined at runtime under target ES2022, but JSON omits them — asserting on
    // the serialised form tests the contract rather than the class shape.
    it('omits absent optional fields from the JSON rather than sending nulls', async () => {
        const sparse: DicomJsonDataset = {
            '00080050': FULL['00080050'],
            '00100010': FULL['00100010'],
            '00100020': FULL['00100020'],
            '0020000D': FULL['0020000D'],
            '00100030': { vr: 'DA' },      // requested but empty, as a RIS returns it
        };
        const { svc } = service([sparse]);
        const [entry] = await svc.getWorklist({});

        const wire = JSON.parse(JSON.stringify(entry));
        expect('patient_birth_date' in wire).toBe(false);
        expect('scheduled' in wire).toBe(false);
        expect(wire.accession_number).toBe('ACC001');
    });
});
