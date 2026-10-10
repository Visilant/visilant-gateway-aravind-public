// DICOM tags as the 8-hex-digit keys used by DICOM JSON (the dcm2json output format).
export const Tag = {
    AccessionNumber: '00080050',
    ReferringPhysicianName: '00080090',
    Modality: '00080060',
    PatientName: '00100010',
    PatientID: '00100020',
    PatientBirthDate: '00100030',
    PatientSex: '00100040',
    StudyInstanceUID: '0020000D',
    RequestedProcedureDescription: '00321060',
    RequestedProcedureID: '00401001',
    ScheduledStationAETitle: '00400001',
    ScheduledProcedureStepStartDate: '00400002',
    ScheduledProcedureStepStartTime: '00400003',
    ScheduledPerformingPhysicianName: '00400006',
    ScheduledProcedureStepDescription: '00400007',
    ScheduledProcedureStepID: '00400009',
    ScheduledProcedureStepSequence: '00400100',
    SOPInstanceUID: '00080018',
    CodeValue: '00080100',
    CodingSchemeDesignator: '00080102',
    CodeMeaning: '00080104',
    AnatomicRegionSequence: '00082218',
    TransferSyntaxUID: '00020010',
    PrivateCreator: '00110010',
    VisilantAssessment: '00111001',
    SeriesInstanceUID: '0020000E',
    ImageLaterality: '00200062',
    IlluminationTypeCodeSequence: '00220016',
    LightPathFilterTypeStackCodeSequence: '00220017',
} as const;

// The same tags in the "gggg,eeee" form the DCMTK command line expects.
export function toCommandLineTag(tag: string): string {
    return `${tag.slice(0, 4)},${tag.slice(4)}`;
}

interface DicomJsonElement {
    vr: string;
    Value?: unknown[];
    // Set instead of Value when dcm2json runs with bulk data enabled and the element is
    // at or above the size threshold.
    BulkDataURI?: string;
}

export type DicomJsonDataset = Record<string, DicomJsonElement | undefined>;

// A tag that was requested but has no value comes back as an element with no `Value`
// key at all, so every read has to tolerate that rather than indexing into undefined.
export function getString(dataset: DicomJsonDataset, tag: string): string | null {
    const value = dataset[tag]?.Value?.[0];
    if (value === undefined || value === null) return null;
    return String(value).trim() || null;
}

// Person Name is the one VR that is not a bare string in DICOM JSON: it is an object
// with Alphabetic / Ideographic / Phonetic components. We keep the Alphabetic form.
export function getPersonName(dataset: DicomJsonDataset, tag: string): string | null {
    const value = dataset[tag]?.Value?.[0];
    if (value === undefined || value === null) return null;
    if (typeof value === 'object' && 'Alphabetic' in (value as Record<string, unknown>)) {
        const alphabetic = (value as { Alphabetic?: unknown }).Alphabetic;
        return alphabetic ? String(alphabetic).trim() || null : null;
    }
    return String(value).trim() || null;
}

export function getSequence(dataset: DicomJsonDataset, tag: string): DicomJsonDataset[] {
    const value = dataset[tag]?.Value;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is DicomJsonDataset => typeof item === 'object' && item !== null);
}
