import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Inject, Service } from 'typedi';
import { isAiAssessment, type AiAssessment } from '../../domain/assessment';
import { LOGGER } from '../../tokens';
import type { Logger } from '../logger';
import { DicomClient } from './DicomClient';
import { BIN, LOCAL_TIMEOUT_MS } from './dicom.constants';
import { DicomJsonDataset, getPersonName, getSequence, getString, Tag } from './dicom.tags';

// dcm2json output for one capture is a few kilobytes once pixel data goes to a bulk
// file, but a large private assessment or a long sequence should not trip the 1 MiB
// default and turn into a confusing "maxBuffer exceeded".
const TAGS_MAX_BUFFER = 64 * 1024 * 1024;

// The curated tag set the operator page shows. Exactly these fields, each null when
// absent; anything else in the file never leaves this module.
export interface CaptureTags {
    patient_name: string | null;
    patient_id: string | null;
    patient_birth_date: string | null;
    patient_sex: string | null;
    accession_number: string | null;
    study_instance_uid: string | null;
    series_instance_uid: string | null;
    sop_instance_uid: string | null;
    modality: string | null;
    image_laterality: string | null;
    anatomic_region: { code_value: string | null; coding_scheme_designator: string | null; code_meaning: string | null } | null;
    illumination: { code_value: string | null; code_meaning: string | null } | null;
    light_path_filter: { code_value: string | null; code_meaning: string | null } | null;
    transfer_syntax_uid: string | null;
    private_creator: string | null;
    assessment: AiAssessment | null;
    assessment_error: 'unparseable' | null;
}

export class PixelDataNotEncapsulatedError extends Error {
    constructor() {
        super('pixel data not encapsulated JPEG');
        this.name = 'PixelDataNotEncapsulatedError';
    }
}

export class DicomJsonParseError extends Error {
    constructor() {
        super('DICOM JSON could not be parsed');
        this.name = 'DicomJsonParseError';
    }
}

// Applies the allowlist. Reads named tags only, so an element that is not listed here
// cannot reach the result however the dataset is shaped.
export function pickTags(dataset: DicomJsonDataset): CaptureTags {
    const illuminationItem = getSequence(dataset, Tag.IlluminationTypeCodeSequence)[0];
    const filterItem = getSequence(dataset, Tag.LightPathFilterTypeStackCodeSequence)[0];
    const regionItem = getSequence(dataset, Tag.AnatomicRegionSequence)[0];
    const { assessment, assessment_error } = readAssessment(dataset);

    return {
        patient_name: getPersonName(dataset, Tag.PatientName),
        patient_id: getString(dataset, Tag.PatientID),
        patient_birth_date: getString(dataset, Tag.PatientBirthDate),
        patient_sex: getString(dataset, Tag.PatientSex),
        accession_number: getString(dataset, Tag.AccessionNumber),
        study_instance_uid: getString(dataset, Tag.StudyInstanceUID),
        series_instance_uid: getString(dataset, Tag.SeriesInstanceUID),
        sop_instance_uid: getString(dataset, Tag.SOPInstanceUID),
        modality: getString(dataset, Tag.Modality),
        image_laterality: getString(dataset, Tag.ImageLaterality),
        anatomic_region: regionItem ? {
            code_value: getString(regionItem, Tag.CodeValue),
            coding_scheme_designator: getString(regionItem, Tag.CodingSchemeDesignator),
            code_meaning: getString(regionItem, Tag.CodeMeaning),
        } : null,
        illumination: illuminationItem
            ? {
                code_value: getString(illuminationItem, Tag.CodeValue),
                code_meaning: getString(illuminationItem, Tag.CodeMeaning),
            }
            : null,
        light_path_filter: filterItem ? { code_value: getString(filterItem, Tag.CodeValue), code_meaning: getString(filterItem, Tag.CodeMeaning) } : null,
        transfer_syntax_uid: getString(dataset, Tag.TransferSyntaxUID),
        private_creator: getString(dataset, Tag.PrivateCreator),
        assessment,
        assessment_error,
    };
}

// Absent (blue and slit captures) is not an error; present but not a valid assessment is.
function readAssessment(dataset: DicomJsonDataset): Pick<CaptureTags, 'assessment' | 'assessment_error'> {
    const raw = getString(dataset, Tag.VisilantAssessment);
    if (raw === null) {
        // A BulkDataURI that could not be read back is present-but-unreadable, not absent.
        return dataset[Tag.VisilantAssessment]?.BulkDataURI
            ? { assessment: null, assessment_error: 'unparseable' }
            : { assessment: null, assessment_error: null };
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (isAiAssessment(parsed)) return { assessment: parsed, assessment_error: null };
    } catch {
        // Falls through to 'unparseable'. Nothing from the value is logged.
    }
    return { assessment: null, assessment_error: 'unparseable' };
}

// Reads a capture's DICOM file for the operator page: the embedded JPEG for preview and
// a curated tag set. Both subprocesses go through the inherited run(), so a failure logs
// the tool's stderr and exit code only. argv holds the absolute path to a patient's file
// and is never logged, and neither is any tag value.
@Service()
export class DicomInspector extends DicomClient {
    constructor(@Inject(LOGGER) logger: Logger) {
        super(logger);
    }

    // Captures are JPEG Baseline, so the encapsulated pixel fragment is the JPEG itself,
    // served as-is with no re-encode.
    async extractJpeg(file: string): Promise<Buffer> {
        // The fragment is the patient's image, so the directory is temporary and removed
        // in the finally below, success or not.
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-preview-'));
        try {
            await this.run(BIN.dcmdump, ['+L', '+W', work, file], 'dcmdump', LOCAL_TIMEOUT_MS);

            // Observed on DCMTK 3.7.0 (macOS, 2026-10-08) for `img2dcm -i JPEG in.jpg
            // out.dcm`: `dcmdump +W` writes one file per pixel item, named
            // `<input basename>.<item index>.raw` — `out.dcm.0.raw` (4 bytes) and
            // `out.dcm.1.raw` (the JPEG). +L was not required; the files are identical
            // with and without it. Index 0 is always the Basic Offset Table (PS3.5 A.4),
            // which is non-empty here (one zero offset), so it is skipped rather than
            // taken as "the first non-empty fragment". Indices are sorted numerically so
            // that 10 does not sort before 2.
            const prefix = `${path.basename(file)}.`;
            const fragments = (await fs.readdir(work))
                .map((name) => ({ name, match: name.startsWith(prefix) ? /\.(\d+)\.raw$/.exec(name) : null }))
                .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
                .map(({ name, match }) => ({ name, index: Number(match[1]) }))
                .filter(({ index }) => index > 0)
                .sort((a, b) => a.index - b.index);

            for (const { name } of fragments) {
                const fragment = path.join(work, name);
                if ((await fs.stat(fragment)).size === 0) continue;
                const bytes = await fs.readFile(fragment);
                // Anything other than a JPEG SOI (JPEG 2000, RLE) cannot be served as
                // image/jpeg.
                if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new PixelDataNotEncapsulatedError();
                return bytes;
            }
            throw new PixelDataNotEncapsulatedError();
        } finally {
            await fs.rm(work, { recursive: true, force: true });
        }
    }

    async readTags(file: string): Promise<CaptureTags> {
        // Plain `dcm2json <file>` cannot be used on a capture: DCMTK 3.7.0 refuses to
        // inline compressed pixel data ("JSON InlineBinary encoding not supported for
        // compressed pixel data", exit 81) and leaves out the meta header, which holds
        // the transfer syntax. `+m` adds the meta header; `+b +bd` writes large
        // elements to bulk files in a temporary directory instead. The size threshold
        // (default 1 kB) applies to every VR, so an assessment UT at or over it also
        // arrives as a BulkDataURI and is read back from that directory below.
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-tags-'));
        try {
            // DCMTK 3.7.0's bulk writer repeatedly traverses PixelData in real -oph
            // files with NumberOfFrames, producing unbounded JSON. Strip pixels from
            // a private temporary copy; the original capture is never modified.
            const metadata = path.join(work, 'metadata.dcm');
            await fs.copyFile(file, metadata);
            await this.run(BIN.dcmodify, ['-nb', '-e', 'PixelData', metadata], 'dcmodify', LOCAL_TIMEOUT_MS);
            const json = await this.run(
                BIN.dcm2json,
                ['+m', '+b', '+bd', work, metadata],
                'dcm2json',
                LOCAL_TIMEOUT_MS,
                TAGS_MAX_BUFFER
            );
            let dataset: DicomJsonDataset;
            try {
                dataset = JSON.parse(json) as DicomJsonDataset;
            } catch {
                // Nothing from the payload is logged: it is PHI.
                throw new DicomJsonParseError();
            }
            if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) throw new DicomJsonParseError();
            await inlineBulkElement(dataset, Tag.VisilantAssessment, work);
            return pickTags(dataset);
        } finally {
            await fs.rm(work, { recursive: true, force: true });
        }
    }
}

// Replaces a BulkDataURI with the text it points at. Only the basename of the URI is
// used, joined to our own directory, so a URI cannot make us read anywhere else.
async function inlineBulkElement(dataset: DicomJsonDataset, tag: string, work: string): Promise<void> {
    const element = dataset[tag];
    if (!element?.BulkDataURI || element.Value !== undefined) return;
    const bulkFile = path.join(work, path.basename(element.BulkDataURI));
    let text: string;
    try {
        text = await fs.readFile(bulkFile, 'utf8');
    } catch {
        // Left as a bare BulkDataURI; pickTags reports that as unparseable rather than
        // absent, which is what it is.
        return;
    }
    // UT is padded to even length with a trailing space; getString trims.
    dataset[tag] = { vr: element.vr, Value: [text.replace(/\0+$/, '')] };
}
