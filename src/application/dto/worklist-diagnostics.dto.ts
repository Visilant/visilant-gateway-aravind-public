import { IsString, Matches, MaxLength } from 'class-validator';

// All three values are required. Empty means remove the corresponding filter.
export class WorklistFiltersDto {
    @IsString() @MaxLength(16) @Matches(/^[\x20-\x7e]*$/)
    requested_procedure_id!: string;
    @IsString() @MaxLength(16) @Matches(/^[\x20-\x7e]*$/)
    modality!: string;
    @IsString() @MaxLength(16) @Matches(/^[\x20-\x7e]*$/)
    scheduled_station_ae!: string;
}

export class SaveWorklistFiltersDto extends WorklistFiltersDto {
    @IsString() @Matches(/^[a-f0-9]{64}$/)
    revision!: string;
}

export interface WorklistCounts {
    extracted_files: number | null;
    converted_files: number;
    invalid_json: number;
    parsed_datasets: number;
    candidate_rows: number;
    accepted_rows: number;
    rejected_rows: number;
    missing_accession: number;
    missing_patient_id: number;
    missing_both: number;
    derived_study_uid: number;
    hidden_completed_rows: number | null;
    returned_rows: number | null;
}

export interface WorklistExplanation {
    id: string;
    request_id: string | null;
    started_at: string;
    duration_ms: number;
    source: 'worklist_request' | 'gateway_probe' | 'filter_preview';
    stage: 'query' | 'conversion' | 'mapping' | 'screening_filter' | 'complete';
    outcome: 'rows_available' | 'no_usable_rows' | 'no_matches' | 'all_completed' | 'failed';
    error_code: string | null;
    counts: WorklistCounts;
    filters: Record<'procedure' | 'modality' | 'station' | 'date' | 'patient' | 'accession', boolean>;
    phone_display: 'not_observed';
    hospital_completion: 'not_integrated';
    recording: boolean;
}
