import { DicomImageTags, SLIT_ILLUMINATION, NO_FILTER } from '../src/infrastructure/dicom';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { BIN } from '../src/infrastructure/dicom/dicom.constants';
import { buildKeyArgs, DicomBuilder, InvalidImageError } from '../src/infrastructure/dicom/DicomBuilder';
import { ToolMissingError } from '../src/infrastructure/dicom/DicomClient';
import type { Logger } from '../src/infrastructure/logger';
import { jpegWithOrientation } from './jpeg-fixtures';

const TAGS: DicomImageTags = {
    patientName: 'DEVI^MEENAKSHI',
    patientId: 'MRN100991',
    studyInstanceUid: '1.2.3',
    seriesInstanceUid: '1.2.3.4',
    sopInstanceUid: '1.2.3.4.5',
    accessionNumber: 'ACC001',
    seriesNumber: 3,
    instanceNumber: 2,
    laterality: 'R',
    pupilDilated: 'NO',
    illumination: SLIT_ILLUMINATION,
    lightPathFilter: NO_FILTER,
};

// img2dcm takes "-k KEY=VALUE" pairs; collect them into a map to assert on.
function keys(tags: DicomImageTags): Record<string, string> {
    const args = buildKeyArgs(tags);
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        expect(args[i]).toBe('-k');
        const [key, ...rest] = args[i + 1].split('=');
        out[key] = rest.join('=');
    }
    return out;
}

describe('buildKeyArgs', () => {
    it('writes the Ophthalmic Photography attributes the pilot set', () => {
        const k = keys(TAGS);
        expect(k.Modality).toBe('OP');
        expect(k.ImageLaterality).toBe('R');
        expect(k.PatientOrientation).toBe('A\\R');
        expect(k.PupilDilated).toBe('NO');
        expect(k.SeriesNumber).toBe('3');
        expect(k.InstanceNumber).toBe('2');
        expect(k['AcquisitionDeviceTypeCodeSequence[0].CodeValue']).toBe('R-1021B');
        expect(k['DeviceSequence[0].CodeMeaning']).toBe('External Camera');
        expect(k['AnatomicRegionSequence[0].CodeValue']).toBe('32259006');
        expect(k['AnatomicRegionSequence[0].CodingSchemeDesignator']).toBe('SCT');
        expect(k['AnatomicRegionSequence[0].CodeMeaning']).toBe('Anterior segment of eye');
        expect(k['IlluminationTypeCodeSequence[0].CodeValue']).toBe('R-1020F');
        expect(k['LightPathFilterTypeStackCodeSequence[0].CodeValue']).toBe('111609');
        expect(k['LightPathFilterTypeStackCodeSequence[0].CodingSchemeDesignator']).toBe('DCM');
    });

    // Type 2 attributes with no value are left for img2dcm to write empty. Passing
    // "PatientBirthDate=" would be the same thing; inventing a value would not.
    it('omits unset values instead of inventing them', () => {
        const k = keys({ ...TAGS, patientName: undefined, pupilDilated: undefined, illumination: undefined });
        expect('PatientName' in k).toBe(false);
        expect('PatientBirthDate' in k).toBe(false);
        expect('PupilDilated' in k).toBe(false);
        expect('IlluminationTypeCodeSequence[0].CodeValue' in k).toBe(false);
    });
});

// DICOM cannot carry an EXIF rotation, so a capture the camera stored turned round must be
// re-encoded upright before img2dcm, or that eye reaches the PACS upside down.
describe('DicomBuilder orientation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'builder-test-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function binariesFor(orientation: number | undefined, fail?: Error): Promise<string[][]> {
        const jpeg = path.join(dir, `capture-${orientation}.jpg`);
        writeFileSync(jpeg, jpegWithOrientation(orientation));
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
        const builder = new DicomBuilder(logger);
        const calls: string[][] = [];
        jest.spyOn(builder as unknown as { run: (bin: string, args: string[]) => Promise<string> }, 'run')
            .mockImplementation(async (bin: string, args: string[]) => { calls.push([bin, ...args]); if (fail && bin === BIN.magick) throw fail; return ''; });
        await builder.build(jpeg, TAGS, path.join(dir, `out-${orientation}.dcm`));
        return calls;
    }

    it('re-encodes a rotated baseline capture upright before img2dcm', async () => {
        const [magick, img2dcm] = await binariesFor(6);
        expect(magick[0]).toBe(BIN.magick);
        expect(magick.indexOf('-auto-orient')).toBeGreaterThan(-1);
        expect(magick.indexOf('-auto-orient')).toBeLessThan(magick.indexOf('-strip'));
        expect(img2dcm[0]).toBe(BIN.img2dcm);
        expect(img2dcm).toContain(magick[magick.length - 1]);
    });

    it.each([1, undefined])('passes an upright baseline capture (orientation %s) straight to img2dcm', async orientation => {
        const calls = await binariesFor(orientation);
        expect(calls.map(([bin]) => bin)).toEqual([BIN.img2dcm]);
    });

    it('reports a missing ImageMagick as a gateway fault, not a bad image', async () => {
        await expect(binariesFor(6, new ToolMissingError('DICOM JPEG normalise failed: magick not found'))).rejects.toBeInstanceOf(ToolMissingError);
    });

    it.each([
        'magick.exe: RegistryKeyLookupFailed `CoderModulesPath\' @ error/module.c/GetMagickModulePath/680.',
        'magick: no decode delegate for this image format `JPEG\'',
    ])('reports a broken ImageMagick install as a gateway fault: %s', async stderr => {
        const result = binariesFor(6, new Error(`DICOM JPEG normalise failed: ${stderr}`));
        await expect(result).rejects.toBeInstanceOf(ToolMissingError);
        await expect(result).rejects.toThrow(/ImageMagick on the gateway/);
    });

    it('still rejects an image ImageMagick cannot read', async () => {
        await expect(binariesFor(6, new Error('DICOM JPEG normalise failed: improper image header'))).rejects.toBeInstanceOf(InvalidImageError);
    });
});
