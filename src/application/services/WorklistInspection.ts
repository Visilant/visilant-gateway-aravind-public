import type { DicomJsonDataset } from '../../infrastructure/dicom';
import type { WorklistEntryDto } from '../dto';

// Request-local only. Never attach this object to diagnostic history or recorder events.
// Whole records are omitted at a limit, rather than silently shortening identifiers.
export const WORKLIST_INSPECTION_LIMITS = { records: 100, record_bytes: 64 * 1024, total_bytes: 512 * 1024, candidate_details: 1000 };

interface InspectedRecord {
    dataset_index: number;
    dicom_json: string;
    candidates: Array<{
        step_index: number | null;
        outcome: 'accepted' | 'missing_accession' | 'missing_patient_id' | 'missing_both';
        effective_study_uid: string | null;
        study_uid_source: 'received' | 'derived' | 'not_mapped';
    }>;
}

export class WorklistInspection {
    private readonly records = new Map<number, InspectedRecord>();
    private observed = 0;
    private bytes = 0;
    private candidateDetails = 0;
    private omittedCandidates = 0;

    // Also called from the conversion loop: earlier records remain inspectable if a
    // later converter fails. Malformed JSON never becomes an incoming dataset here.
    receive(dataset: DicomJsonDataset, index: number): void {
        if (index <= this.observed) return;
        this.observed = index;
        if (this.records.size >= WORKLIST_INSPECTION_LIMITS.records) return;
        const json = JSON.stringify(dataset);
        const bytes = Buffer.byteLength(json);
        if (bytes > WORKLIST_INSPECTION_LIMITS.record_bytes || this.bytes + bytes > WORKLIST_INSPECTION_LIMITS.total_bytes) return;
        this.records.set(index, { dataset_index: index, dicom_json: json, candidates: [] });
        this.bytes += bytes;
    }

    candidate(index: number, step: number | null, entry: WorklistEntryDto | null, accession: boolean, patient: boolean, receivedUid: boolean): void {
        const record = this.records.get(index);
        if (!record) return;
        if (this.candidateDetails >= WORKLIST_INSPECTION_LIMITS.candidate_details) { this.omittedCandidates++; return; }
        const candidate: InspectedRecord['candidates'][number] = { step_index: step,
            outcome: entry ? 'accepted' : !accession && !patient ? 'missing_both' : !accession ? 'missing_accession' : 'missing_patient_id',
            effective_study_uid: entry?.study_instance_uid ?? null,
            study_uid_source: entry ? receivedUid ? 'received' : 'derived' : 'not_mapped',
        };
        const bytes = Buffer.byteLength(JSON.stringify(candidate));
        if (this.bytes + bytes > WORKLIST_INSPECTION_LIMITS.total_bytes) { this.omittedCandidates++; return; }
        this.candidateDetails++;
        this.bytes += bytes;
        record.candidates.push(candidate);
    }

    snapshot() {
        return { records: [...this.records.values()], parsed_datasets_observed: this.observed,
            omitted_records: this.observed - this.records.size, omitted_candidate_details: this.omittedCandidates,
            limits: { ...WORKLIST_INSPECTION_LIMITS } };
    }
}
