// Coded concepts written into Ophthalmic Photography objects. Values follow the Aravind
// integration pilot (Visilant Vision Center DICOM MWL documentation, §5a), with
// anterior-segment anatomy and DICOM filter schemes clarified below.
export interface CodedConcept {
    value: string;
    scheme: string;
    meaning: string;
}

// Acquisition Device Type (0022,0015) and Device Sequence (0050,0010): a phone camera.
export const EXTERNAL_CAMERA: CodedConcept = { value: 'R-1021B', scheme: 'SRT', meaning: 'External Camera' };

// Anatomic Region (0008,2218): these captures image the anterior segment.
// CID 4209 is extensible; this SNOMED CT anatomy concept makes the scope explicit.
// https://hl7.org/fhir/uv/eyecare/2021Sep/ValueSet-body-site-eye.html
export const ANTERIOR_SEGMENT_OF_EYE: CodedConcept = { value: '32259006', scheme: 'SCT', meaning: 'Anterior segment of eye' };

// Illumination Type (0022,0016).
export const SLIT_ILLUMINATION: CodedConcept = {
    value: 'R-1020F', scheme: 'SRT', meaning: 'Fine slit beam direct illumination',
};
export const DIFFUSE_ILLUMINATION: CodedConcept = {
    value: 'R-1020E', scheme: 'SRT', meaning: 'Dual diffuse direct illumination',
};

// Light Path Filter Type Stack (0022,0017). The pilot labelled these SRT, but 111603
// and 111609 are DICOM-defined codes (CID 4204), so the scheme here is DCM — a viewer
// resolving the code against SRT would find nothing.
export const BLUE_FILTER: CodedConcept = { value: '111603', scheme: 'DCM', meaning: 'Blue filter' };
export const NO_FILTER: CodedConcept = { value: '111609', scheme: 'DCM', meaning: 'No filter' };
