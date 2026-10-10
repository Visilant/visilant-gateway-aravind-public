import { execFile, execFileSync } from 'child_process';
import { existsSync, promises as fs, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AiAssessment } from '../src/domain/assessment';
import { DicomBuilder, BLUE_FILTER, DIFFUSE_ILLUMINATION, DicomInspector, DicomJsonParseError, PixelDataNotEncapsulatedError, pickTags } from '../src/infrastructure/dicom';
import type { DicomJsonDataset } from '../src/infrastructure/dicom';

// execFile is replaced by a plain jest.fn so promisify resolves with whatever the mock
// passes as its second callback argument. Every other child_process export stays real,
// so the native test below can still build a file with execFileSync.
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

const execFileMock = execFile as unknown as jest.Mock;
const realExecFile = jest.requireActual('child_process').execFile as typeof execFile;

const assessment: AiAssessment = {
    schemaVersion: 1, status: 'unavailable', modelRevision: 'models-v1',
    modelManifestSha256: 'a'.repeat(64), assessedAt: '2026-10-08T12:00:00.000Z',
};

function fixture(assessmentValue?: string): DicomJsonDataset {
    const dataset: DicomJsonDataset = {
        '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYNTHETIC^PATIENT' }] },
        '00100020': { vr: 'LO', Value: ['SYN001'] },
        '00100030': { vr: 'DA', Value: ['19700101'] },
        '00100040': { vr: 'CS', Value: ['F'] },
        '00080050': { vr: 'SH', Value: ['ACC001'] },
        '0020000D': { vr: 'UI', Value: ['1.2.3'] },
        '0020000E': { vr: 'UI', Value: ['1.2.3.4'] },
        '00080018': { vr: 'UI', Value: ['1.2.3.4.5'] },
        '00080060': { vr: 'CS', Value: ['OP'] },
        '00200062': { vr: 'CS', Value: ['R'] },
        '00082218': { vr: 'SQ', Value: [{
            '00080100': { vr: 'SH', Value: ['32259006'] },
            '00080102': { vr: 'SH', Value: ['SCT'] },
            '00080104': { vr: 'LO', Value: ['Anterior segment of eye'] },
        }] },
        '00220016': { vr: 'SQ', Value: [{
            '00080100': { vr: 'SH', Value: ['R-102C0'] },
            '00080104': { vr: 'LO', Value: ['Full Spectrum'] },
        }] },
        '00220017': { vr: 'SQ', Value: [{ '00080100': { vr: 'SH', Value: ['111603'] }, '00080104': { vr: 'LO', Value: ['Blue filter'] } }] },
        '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.4.50'] },
        '00110010': { vr: 'LO', Value: ['VISILANT_AI_1'] },
        // Outside the allowlist: must never reach the result.
        '00101000': { vr: 'LO', Value: ['OTHER-ID-SECRET'] },
        '00080080': { vr: 'LO', Value: ['SECRET HOSPITAL'] },
    };
    if (assessmentValue !== undefined) dataset['00111001'] = { vr: 'UT', Value: [assessmentValue] };
    return dataset;
}

const EXPECTED_KEYS = [
    'patient_name', 'patient_id', 'patient_birth_date', 'patient_sex', 'accession_number',
    'study_instance_uid', 'series_instance_uid', 'sop_instance_uid', 'modality', 'image_laterality',
    'illumination', 'light_path_filter', 'anatomic_region', 'transfer_syntax_uid', 'private_creator', 'assessment', 'assessment_error',
].sort();

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('pickTags', () => {
    it('returns exactly the allowlisted fields and nothing else', () => {
        const tags = pickTags(fixture(JSON.stringify(assessment)));
        expect(Object.keys(tags).sort()).toEqual(EXPECTED_KEYS);
        expect(tags).toEqual({
            patient_name: 'SYNTHETIC^PATIENT', patient_id: 'SYN001', patient_birth_date: '19700101',
            patient_sex: 'F', accession_number: 'ACC001', study_instance_uid: '1.2.3',
            series_instance_uid: '1.2.3.4', sop_instance_uid: '1.2.3.4.5', modality: 'OP',
            image_laterality: 'R', illumination: { code_value: 'R-102C0', code_meaning: 'Full Spectrum' },
            light_path_filter: { code_value: '111603', code_meaning: 'Blue filter' },
            anatomic_region: { code_value: '32259006', coding_scheme_designator: 'SCT', code_meaning: 'Anterior segment of eye' },
            transfer_syntax_uid: '1.2.840.10008.1.2.4.50', private_creator: 'VISILANT_AI_1',
            assessment, assessment_error: null,
        });
        expect(JSON.stringify(tags)).not.toContain('SECRET');
    });

    it('flags an assessment that is present but not JSON', () => {
        const tags = pickTags(fixture('not json'));
        expect(tags.assessment).toBeNull();
        expect(tags.assessment_error).toBe('unparseable');
    });

    it('flags an assessment that is JSON but not a valid AiAssessment', () => {
        const tags = pickTags(fixture(JSON.stringify({ ...assessment, status: 'ready' })));
        expect(tags.assessment).toBeNull();
        expect(tags.assessment_error).toBe('unparseable');
    });

    it('reports no assessment and no error when the element is absent', () => {
        const tags = pickTags(fixture());
        expect(tags.assessment).toBeNull();
        expect(tags.assessment_error).toBeNull();
    });

    it('gives null for every field of an empty dataset', () => {
        const tags = pickTags({});
        expect(Object.keys(tags).sort()).toEqual(EXPECTED_KEYS);
        expect(Object.values(tags).every((v) => v === null)).toBe(true);
    });
});

describe('DicomInspector', () => {
    beforeEach(() => { jest.spyOn(fs, 'copyFile').mockResolvedValue(); });
    afterEach(() => {
        jest.restoreAllMocks();
        execFileMock.mockReset();
    });

    // execFile puts argv into err.message, and argv here is the absolute path to a
    // patient's file. Only stderr and the exit code may reach the log.
    it('logs only stderr when dcm2json fails, never argv or err.message', async () => {
        execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
            cb(Object.assign(new Error('Command failed: dcm2json /abs/SECRET.dcm -k PatientName=SECRET'), {
                stderr: 'E: cannot open file', code: 1,
            }));
        });
        const logger = makeLogger();
        const inspector = new DicomInspector(logger as never);

        await expect(inspector.readTags('/abs/SECRET.dcm')).rejects.toThrow('cannot open file');

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(String(logger.error.mock.calls[0][0])).toContain('cannot open file');
        const everything = JSON.stringify([logger.info, logger.warn, logger.error, logger.debug].map((m) => m.mock.calls));
        expect(everything).not.toContain('/abs');
        expect(everything).not.toContain('-k');
        expect(everything).not.toContain('SECRET');
    });

    it('throws PixelDataNotEncapsulatedError when dcmdump writes no fragment, and removes its tmpdir', async () => {
        execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
            cb(null, { stdout: '', stderr: '' });
        });
        const created: string[] = [];
        const realMkdtemp = fs.mkdtemp.bind(fs);
        jest.spyOn(fs, 'mkdtemp').mockImplementation((async (prefix: string) => {
            const dir = await realMkdtemp(prefix);
            created.push(dir);
            return dir;
        }) as never);
        const inspector = new DicomInspector(makeLogger() as never);

        await expect(inspector.extractJpeg('/abs/capture.dcm')).rejects.toBeInstanceOf(PixelDataNotEncapsulatedError);

        expect(created).toHaveLength(1);
        expect(path.basename(created[0])).toMatch(/^visilant-preview-/);
        expect(existsSync(created[0])).toBe(false);
    });

    // dcm2json's bulk threshold applies to every VR, so a large assessment UT arrives as
    // a BulkDataURI pointing into the directory we passed with +bd.
    it('reads an assessment that dcm2json wrote as bulk data', async () => {
        let args: string[] = [];
        execFileMock.mockImplementation((_bin: string, a: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
            if (!a.includes('+bd')) { cb(null, { stdout: '', stderr: '' }); return; }
            args = a;
            const dir = a[a.indexOf('+bd') + 1];
            writeFileSync(path.join(dir, 'abc.bin'), JSON.stringify(assessment) + ' ');
            cb(null, { stdout: JSON.stringify({
                '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.4.50'] },
                '00111001': { vr: 'UT', BulkDataURI: `file://localhost${dir}/abc.bin` },
            }), stderr: '' });
        });
        const inspector = new DicomInspector(makeLogger() as never);

        const tags = await inspector.readTags('/abs/capture.dcm');

        expect(args.slice(0, 3)).toEqual(['+m', '+b', '+bd']);
        expect(path.basename(args[args.length - 1])).toBe('metadata.dcm');
        expect(existsSync(args[3])).toBe(false);
        expect(tags.assessment).toEqual(assessment);
        expect(tags.assessment_error).toBeNull();
    });

    it('throws DicomJsonParseError when dcm2json output is not JSON', async () => {
        execFileMock.mockImplementation((_bin: string, _a: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
            cb(null, { stdout: '{ "00100010": SECRET', stderr: '' });
        });
        const logger = makeLogger();
        await expect(new DicomInspector(logger as never).readTags('/abs/capture.dcm')).rejects.toBeInstanceOf(DicomJsonParseError);
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET');
    });
});

// img2dcm drops the JPEG's APPn segments (the JFIF header ImageMagick writes) when it
// encapsulates, both here and in DicomBuilder, so the fragment is the source JPEG minus
// those segments rather than byte-for-byte the source.
function stripAppSegments(jpeg: Buffer): Buffer {
    let offset = 2;
    while (jpeg[offset] === 0xff && jpeg[offset + 1] >= 0xe0 && jpeg[offset + 1] <= 0xef) {
        offset += 2 + jpeg.readUInt16BE(offset + 2);
    }
    return Buffer.concat([jpeg.subarray(0, 2), jpeg.subarray(offset)]);
}

// DCMTK integration stays opt-in on machines that do not have the binaries.
const nativeTest = process.env.TEST_DCMTK === '1' ? test : test.skip;
nativeTest('extracts the embedded JPEG and reads tags from a real img2dcm file', async () => {
    // The mock has no promisify.custom, so promisify resolves with the callback's second
    // argument; hand the real result back in the { stdout, stderr } shape run() expects.
    execFileMock.mockImplementation((bin: string, args: string[], opts: object, cb: (e: unknown, r?: unknown) => void) =>
        realExecFile(bin, args, opts, (err, stdout, stderr) => (err ? cb(Object.assign(err, { stdout, stderr })) : cb(null, { stdout, stderr }))));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-inspector-test-'));
    try {
        const jpeg = path.join(directory, 'in.jpg'), output = path.join(directory, 'out.dcm');
        execFileSync('magick', ['-size', '1600x1200', 'plasma:fractal', '-quality', '90', jpeg]);
        execFileSync('img2dcm', ['-i', 'JPEG', jpeg, output]);
        const logger = makeLogger();
        const inspector = new DicomInspector(logger as never);

        const extracted = await inspector.extractJpeg(output);
        const source = await fs.readFile(jpeg);
        expect(extracted[0]).toBe(0xff);
        expect(extracted[1]).toBe(0xd8);
        const expected = stripAppSegments(source);
        // DICOM pads an odd-length fragment with one trailing zero byte.
        expect(extracted.length).toBe(expected.length + (expected.length % 2));
        expect(extracted.subarray(0, expected.length).equals(expected)).toBe(true);

        const tags = await inspector.readTags(output);
        expect(tags.transfer_syntax_uid).toBe('1.2.840.10008.1.2.4.50');
        expect(tags.assessment).toBeNull();
        expect(tags.assessment_error).toBeNull();
        expect(logger.error).not.toHaveBeenCalled();
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}, 30_000);


nativeTest('reads a real Ophthalmic Photography capture without unbounded bulk JSON and leaves it unchanged', async () => {
    execFileMock.mockImplementation((bin: string, args: string[], opts: object, cb: (e: unknown, r?: unknown) => void) =>
        realExecFile(bin, args, opts, (err, stdout, stderr) => cb(err, { stdout, stderr })));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-inspector-oph-'));
    try {
        const jpeg = path.join(directory, 'eye.jpg'), file = path.join(directory, 'capture.dcm');
        execFileSync('magick', ['-size', '1600x1200', 'gradient:navy-white', '-interlace', 'none', jpeg]);
        const logger = makeLogger();
        await new DicomBuilder(logger as never).build(jpeg, {
            patientName: 'SYNTHETIC^PATIENT', patientId: 'SYNTHETIC', accessionNumber: 'SYN001',
            studyInstanceUid: '1.2.3', seriesInstanceUid: '1.2.3.4', sopInstanceUid: '1.2.3.4.5',
            seriesNumber: 1, instanceNumber: 1, laterality: 'R', captureLight: 'BLUE',
            illumination: DIFFUSE_ILLUMINATION, lightPathFilter: BLUE_FILTER,
        }, file);
        const original = await fs.readFile(file);
        const inspector = new DicomInspector(logger as never), tags = await inspector.readTags(file);
        expect(tags.anatomic_region).toEqual({ code_value: '32259006', coding_scheme_designator: 'SCT', code_meaning: 'Anterior segment of eye' });
        const anatomy = execFileSync('dcmdump', ['+P', '0008,2218', '+P', '0022,0015', file], { encoding: 'utf8' });
        expect(anatomy).toContain('Anterior segment of eye');
        expect(anatomy).not.toMatch(/fundus/i);
        expect(tags).toMatchObject({ patient_name: 'SYNTHETIC^PATIENT', image_laterality: 'R', accession_number: 'SYN001', light_path_filter: { code_value: '111603', code_meaning: 'Blue filter' }, transfer_syntax_uid: '1.2.840.10008.1.2.4.50', assessment: null });
        expect(await fs.readFile(file)).toEqual(original);
        expect((await inspector.extractJpeg(file)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        expect(logger.error).not.toHaveBeenCalled();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 30_000);
