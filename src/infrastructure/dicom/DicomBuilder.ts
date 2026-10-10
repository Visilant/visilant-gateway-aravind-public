import { diagnostics, profile } from '../diagnostics';
import { isAiAssessment, type AiAssessment } from '../../domain/assessment';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Inject, Service } from 'typedi';
import { LOGGER } from '../../tokens';
import type { Logger } from '../logger';
import { readJpegProfile } from '../image/jpeg';
import { DicomClient, ToolMissingError } from './DicomClient';
import { CodedConcept, EXTERNAL_CAMERA, ANTERIOR_SEGMENT_OF_EYE } from './dicom.codes';
import { BIN, LOCAL_TIMEOUT_MS } from './dicom.constants';

// DICOM attributes written into the generated object. CONTAINS PHI — never logged.
// Optional values that are absent are left for img2dcm to write empty (DICOM Type 2)
// rather than invented.
export interface DicomImageTags {
    aiAssessment?: AiAssessment;
    captureLight?: 'WHITE' | 'SLIT' | 'BLUE';
    patientName?: string;
    patientId?: string;
    patientBirthDate?: string;   // DA: YYYYMMDD
    patientSex?: string;         // M | F | O
    studyInstanceUid: string;
    seriesInstanceUid: string;
    sopInstanceUid: string;
    accessionNumber?: string;
    studyId?: string;
    studyDate?: string;          // DA
    studyTime?: string;          // TM
    referringPhysician?: string;
    studyDescription?: string;
    seriesDescription?: string;
    seriesNumber: number;
    instanceNumber: number;
    laterality: 'L' | 'R';
    pupilDilated?: string;       // YES | NO
    illumination?: CodedConcept;
    lightPathFilter?: CodedConcept;
}

// The upload is not an image we can convert — the caller's fault, not the gateway's.
export class InvalidImageError extends Error {}

// ImageMagick messages that mean its installation is broken, whatever the input.
const IMAGEMAGICK_INSTALL_FAULT = /RegistryKeyLookupFailed|UnableToLoadModule|unable to load module|no (decode|encode) delegate/i;

// Turns a captured JPEG into an Ophthalmic Photography 8 Bit object on disk — the SOP
// class the Aravind PACS expects (1.2.840.10008.5.1.4.1.1.77.1.5.1), Modality OP.
//
// This runs at capture time rather than at send time. The demographics therefore live
// inside the .dcm file and never reach the database, a retry is a plain re-send of a
// finished file, and a tagging problem surfaces while the operator is still at the slit
// lamp instead of silently in a worker an hour later.
@Service()
export class DicomBuilder extends DicomClient {
    constructor(@Inject(LOGGER) logger: Logger) {
        super(logger);
    }

    @profile('dicom.build')
    async build(jpegPath: string, tags: DicomImageTags, outputPath: string): Promise<void> {
        if (tags.aiAssessment !== undefined && (tags.captureLight !== 'WHITE' || !isAiAssessment(tags.aiAssessment))) {
            throw new InvalidImageError('AI assessment requires WHITE light and a valid assessment');
        }
        const source = await this.ensureBaseline(jpegPath);
        let privateDirectory: string | undefined;

        try {
            await fs.mkdir(path.dirname(outputPath), { recursive: true });
            // -oph writes the Ophthalmic Photography IOD, including the synchronization,
            // multi-frame and lossy-compression attributes the pilot set by hand.
            const templateArgs: string[] = [];
            if (tags.aiAssessment) {
                privateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-ai-'));
                const template = path.join(privateDirectory, 'assessment.xml');
                await fs.writeFile(template, assessmentXml(tags.aiAssessment), { mode: 0o600 });
                templateArgs.push('-dx', template);
            }
            await this.run(
                BIN.img2dcm,
                ['-oph', ...templateArgs, source.path, outputPath, ...buildKeyArgs(tags)],
                'img2dcm',
                LOCAL_TIMEOUT_MS
            );
        } finally {
            if (privateDirectory) await fs.rm(privateDirectory, { recursive: true, force: true });
            if (source.temporary) {
                await fs.rm(path.dirname(source.path), { recursive: true, force: true });
            }
        }
    }

    // img2dcm keeps JPEG pixel data encapsulated rather than decoding it, and only
    // accepts a baseline frame. It also drops EXIF, so a capture the camera stored
    // rotated (an orientation tag rather than rotated pixels) would reach the PACS upside
    // down. We read the header first and re-encode only a non-baseline or rotated
    // capture; an upright baseline JPEG goes to img2dcm untouched.
    @profile('dicom.ensureBaseline')
    private async ensureBaseline(jpegPath: string): Promise<{ path: string; temporary: boolean }> {
        const header = await readHead(jpegPath, 64 * 1024);
        const profile = readJpegProfile(header);
        const rotated = profile.orientation !== 1;
        diagnostics.event('jpeg.profile', { baseline: profile.isBaseline, status: rotated ? 'rotated' : 'upright' });

        if (!profile.isJpeg) {
            throw new InvalidImageError('capture is not a JPEG image');
        }
        if (profile.isBaseline && !rotated) {
            return { path: jpegPath, temporary: false };
        }

        this.logger.info(rotated
            ? 'capture carries an EXIF rotation; re-encoding upright before conversion'
            : 'capture is not baseline JPEG; re-encoding before conversion');

        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-jpeg-'));
        const baseline = path.join(work, 'baseline.jpg');
        try {
            await this.run(
                BIN.magick,
                [jpegPath, '-auto-orient', '-interlace', 'none', '-sampling-factor', '2x1', '-strip', '-quality', '92', baseline],
                'JPEG normalise',
                LOCAL_TIMEOUT_MS
            );
        } catch (err) {
            await fs.rm(work, { recursive: true, force: true });
            // A missing ImageMagick is this box's fault, not the upload's: rethrow so the
            // capture fails as a server error the app retries, not a 400 it gives up on.
            // Every capture shot with the phone turned round comes through here.
            if (err instanceof ToolMissingError) throw err;
            // The header already said JPEG, so ImageMagick failing to load its own JPEG
            // coder is the same kind of fault: an installer build of ImageMagick copied
            // without its registry keys fails exactly like this on every capture.
            if (err instanceof Error && IMAGEMAGICK_INSTALL_FAULT.test(err.message)) {
                throw new ToolMissingError(`ImageMagick on the gateway cannot convert images (${err.message}). Reinstall the Windows bundle built with the portable ImageMagick.`);
            }
            throw new InvalidImageError('capture could not be read as a JPEG image');
        }
        return { path: baseline, temporary: true };
    }
}

async function readHead(filePath: string, bytes: number): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

// Maps tags to img2dcm `-k KEY=VALUE` arguments, skipping anything unset. Exported for
// tests; the argument list is PHI and must never be logged.
export function buildKeyArgs(tags: DicomImageTags): string[] {
    const pairs: Array<[string, string | undefined]> = [
        ['PatientName', tags.patientName],
        ['PatientID', tags.patientId],
        ['PatientBirthDate', tags.patientBirthDate],
        ['PatientSex', tags.patientSex],
        ['StudyInstanceUID', tags.studyInstanceUid],
        ['SeriesInstanceUID', tags.seriesInstanceUid],
        ['SOPInstanceUID', tags.sopInstanceUid],
        ['AccessionNumber', tags.accessionNumber],
        ['StudyID', tags.studyId],
        ['StudyDate', tags.studyDate],
        ['StudyTime', tags.studyTime],
        ['ReferringPhysicianName', tags.referringPhysician],
        ['StudyDescription', tags.studyDescription],
        ['SeriesDescription', tags.seriesDescription],
        ['SeriesNumber', String(tags.seriesNumber)],
        ['InstanceNumber', String(tags.instanceNumber)],
        ['Modality', 'OP'],
        ['Manufacturer', 'Visilant'],
        ['ImageLaterality', tags.laterality],
        // Row direction anterior, column direction toward the imaged eye's side.
        ['PatientOrientation', `A\\${tags.laterality}`],
        ['PupilDilated', tags.pupilDilated],
    ];

    const args: string[] = [];
    for (const [key, value] of pairs) {
        if (value !== undefined && value !== '') args.push('-k', `${key}=${value}`);
    }

    const coded = (sequence: string, concept: CodedConcept | undefined) => {
        if (!concept) return;
        args.push(
            '-k', `${sequence}[0].CodeValue=${concept.value}`,
            '-k', `${sequence}[0].CodingSchemeDesignator=${concept.scheme}`,
            '-k', `${sequence}[0].CodeMeaning=${concept.meaning}`,
        );
    };

    coded('AcquisitionDeviceTypeCodeSequence', EXTERNAL_CAMERA);
    coded('DeviceSequence', EXTERNAL_CAMERA);
    coded('AnatomicRegionSequence', ANTERIOR_SEGMENT_OF_EYE);
    coded('IlluminationTypeCodeSequence', tags.illumination);
    coded('LightPathFilterTypeStackCodeSequence', tags.lightPathFilter);

    return args;
}

// A fresh JPEG conversion has no private blocks. Reserve 0011/10 for this creator.
// Explicit UT in the template preserves the JSON without a site dictionary.
export const AI_PRIVATE_CREATOR = 'VISILANT_AI_1';
export function assessmentXml(assessment: AiAssessment): string {
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<data-set xfer="1.2.840.10008.1.2.1">
<element tag="0011,0010" vr="LO" vm="1">${AI_PRIVATE_CREATOR}</element>
<element tag="0011,1001" vr="UT" vm="1">${escape(JSON.stringify(assessment))}</element>
</data-set>
`;
}
