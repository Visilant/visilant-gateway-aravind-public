import { ScreeningService } from './ScreeningService';
import { WorklistInspection } from './WorklistInspection';
import { diagnosticContext, diagnostics, profile } from '../../infrastructure/diagnostics';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { Inject, Service } from 'typedi';
import type { GatewayConfig, MwlNodeConfig } from '../../config';
import { WorklistQueryError } from '../../infrastructure/dicom/WorklistClient';
import { WorklistExplanation, WorklistFiltersDto } from '../dto/worklist-diagnostics.dto';
import {
    DicomJsonDataset,
    Tag,
    WorklistClient,
    deriveUid,
    getPersonName,
    getSequence,
    getString,
} from '../../infrastructure/dicom';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER } from '../../tokens';
import { ScheduledStepDto, WorklistEntryDto, WorklistQueryDto } from '../dto';

@Service()
export class WorklistService {
    private readonly history: WorklistExplanation[] = [];
    private probeRunning = false;
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly worklistClient: WorklistClient,
        private readonly screenings: ScreeningService,
    ) {}

    @profile('worklist.getWorklist')
    async getWorklist(query: WorklistQueryDto = {}): Promise<WorklistEntryDto[]> {
        return (await this.explain(query, 'worklist_request')).entries;
    }

    recent(): WorklistExplanation[] { return structuredClone(this.history); }

    async probe(filters?: WorklistFiltersDto): Promise<WorklistExplanation> {
        return (await this.runProbe(filters)).report;
    }

    async inspect() {
        const inspection = new WorklistInspection();
        const result = await this.runProbe(undefined, inspection);
        return { check: result.report, query: result.inspectedQuery, ...inspection.snapshot() };
    }

    private async runProbe(filters?: WorklistFiltersDto, inspection?: WorklistInspection) {
        if (this.probeRunning) throw new WorklistProbeBusyError();
        this.probeRunning = true;
        try {
            return await this.explain({}, filters ? 'filter_preview' : 'gateway_probe', filters, inspection);
        } finally { this.probeRunning = false; }
    }

    private async explain(query: WorklistQueryDto, source: WorklistExplanation['source'], filters?: WorklistFiltersDto, inspection?: WorklistInspection) {
        const started = performance.now();
        const node: MwlNodeConfig = { ...this.config.mwl, ...(filters ? Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value.trim()])) : {}) };
        const inspectedQuery = inspection ? { host: node.host, port: node.port, called_ae: node.called_ae, calling_ae: node.calling_ae,
            requested_procedure_id: node.requested_procedure_id ?? '', modality: node.modality ?? '', scheduled_station_ae: node.scheduled_station_ae ?? '' } : undefined;
        const report: WorklistExplanation = {
            id: randomUUID(), request_id: diagnosticContext.getStore()?.request_id ?? null,
            started_at: new Date().toISOString(), duration_ms: 0, source, stage: 'query', outcome: 'failed', error_code: null,
            counts: { extracted_files: null, converted_files: 0, invalid_json: 0, parsed_datasets: 0, candidate_rows: 0,
                accepted_rows: 0, rejected_rows: 0, missing_accession: 0, missing_patient_id: 0, missing_both: 0,
                derived_study_uid: 0, hidden_completed_rows: null, returned_rows: null },
            filters: { procedure: !!node.requested_procedure_id, modality: !!node.modality, station: !!node.scheduled_station_ae,
                date: !!query.date, patient: !!query.patient_id, accession: !!query.accession_number },
            phone_display: 'not_observed', hospital_completion: 'not_integrated', recording: diagnostics.enabled,
        };
        const counts = report.counts;
        try {
            const datasets = await this.worklistClient.query(node, {
                // No date unless the caller asks for one. The MWL holds open orders only and
                // the configured procedure ID already narrows it; a today-only default would
                // hide an order booked yesterday that the patient is sitting in front of now.
                scheduledDate: query.date,
                patientId: query.patient_id,
                accessionNumber: query.accession_number,
            }, conversion => Object.assign(counts, conversion), inspection ? (dataset, index) => inspection.receive(dataset, index) : undefined);
            counts.parsed_datasets = datasets.length;
            report.stage = 'mapping';

            const entries: WorklistEntryDto[] = [];
            let unusable = 0;

            for (const [datasetIndex, dataset] of datasets.entries()) {
                inspection?.receive(dataset, datasetIndex + 1);
                const steps = getSequence(dataset, Tag.ScheduledProcedureStepSequence);
                for (const [stepIndex, step] of (steps.length ? steps : [undefined]).entries()) {
                    counts.candidate_rows++;
                    const entry = this.toEntry(dataset, step);
                    inspection?.candidate(datasetIndex + 1, step ? (dataset[Tag.ScheduledProcedureStepSequence]?.Value?.indexOf(step) ?? stepIndex) + 1 : null, entry,
                        !!getString(dataset, Tag.AccessionNumber), !!getString(dataset, Tag.PatientID), !!getString(dataset, Tag.StudyInstanceUID));
                    if (entry) {
                        entries.push(entry);
                        counts.accepted_rows++;
                        if (!getString(dataset, Tag.StudyInstanceUID)) counts.derived_study_uid++;
                    } else {
                        unusable++;
                        counts.rejected_rows++;
                        const accession = !!getString(dataset, Tag.AccessionNumber), patient = !!getString(dataset, Tag.PatientID);
                        if (!accession && !patient) counts.missing_both++;
                        else if (!accession) counts.missing_accession++;
                        else counts.missing_patient_id++;
                    }
                }
            }

            if (unusable > 0) {
                // Counted, never described: the contents are PHI. An entry missing any of
                // these cannot be captured against, so returning it would only produce a
                // row in the app that fails at the moment someone takes a photo.
                this.logger.warn(
                    `worklist: skipped ${unusable} entr${unusable === 1 ? 'y' : 'ies'} ` +
                    `missing an accession number or patient ID`
                );
            }

            counts.accepted_rows = entries.length;
            counts.rejected_rows = unusable;
            report.stage = 'screening_filter';
            const result = await this.screenings.filter(entries, source === 'worklist_request');
            counts.hidden_completed_rows = entries.length - result.length;
            counts.returned_rows = result.length;
            report.stage = 'complete';
            report.outcome = result.length ? 'rows_available' : entries.length ? 'all_completed' :
                counts.candidate_rows || counts.invalid_json ? 'no_usable_rows' : 'no_matches';
            return { entries: result, report, inspectedQuery };
        } catch (error) {
            if (error instanceof WorklistQueryError) { report.stage = error.stage; report.error_code = error.code; }
            else report.error_code = report.stage === 'screening_filter' ? 'SCREENING_FILTER_FAILED' :
                report.stage === 'mapping' ? 'ROW_MAPPING_FAILED' : 'MWL_QUERY_FAILED';
            if (source === 'worklist_request') throw error;
            return { entries: [], report, inspectedQuery };
        } finally {
            report.duration_ms = Math.round(performance.now() - started);
            this.history.unshift(report);
            this.history.splice(20);
            // Values are deliberately absent. Record only counts, presence and generated IDs.
            diagnostics.event('worklist.explanation', { check_id: report.id, ...counts, stage: report.stage,
                source, status: report.outcome, error_code: report.error_code,
                ...Object.fromEntries(Object.entries(report.filters).map(([key, value]) => [`filter_${key}`, value])) }, report.duration_ms, report.outcome === 'failed' ? 'error' : 'ok');
        }
    }

    // Null when the accession or patient ID is missing; see the skipped-entry warning above.
    private toEntry(dataset: DicomJsonDataset, step?: DicomJsonDataset): WorklistEntryDto | null {
        const accession = getString(dataset, Tag.AccessionNumber);
        const patientId = getString(dataset, Tag.PatientID);

        if (!accession || !patientId) return null;

        const entry = new WorklistEntryDto();
        entry.accession_number = accession;
        // The RIS's own Study UID whenever it sends one — an image under any other UID
        // lands in a different study from the order. Only when it is absent do we mint
        // one, derived from the accession so every capture for the order shares it.
        entry.study_instance_uid = getString(dataset, Tag.StudyInstanceUID)
            ?? deriveUid(`study:${accession}`, this.config.study_uid_root);
        entry.patient_id = patientId;
        assign(entry, 'patient_name', getPersonName(dataset, Tag.PatientName));
        assign(entry, 'patient_birth_date', getString(dataset, Tag.PatientBirthDate));
        assign(entry, 'patient_sex', normalizeSex(getString(dataset, Tag.PatientSex)));
        assign(entry, 'referring_physician', getPersonName(dataset, Tag.ReferringPhysicianName));
        assign(entry, 'requested_procedure_id', getString(dataset, Tag.RequestedProcedureID));
        assign(entry, 'requested_procedure_description', getString(dataset, Tag.RequestedProcedureDescription));

        if (step) entry.scheduled = toScheduledStep(step);

        return entry;
    }
}

export class WorklistProbeBusyError extends Error {
    constructor() { super('A gateway worklist check is already running. Wait for it to finish.'); }
}

function toScheduledStep(step: DicomJsonDataset): ScheduledStepDto {
    const scheduled = new ScheduledStepDto();
    assign(scheduled, 'modality', getString(step, Tag.Modality));
    assign(scheduled, 'station_ae', getString(step, Tag.ScheduledStationAETitle));
    assign(scheduled, 'start_date', getString(step, Tag.ScheduledProcedureStepStartDate));
    assign(scheduled, 'start_time', getString(step, Tag.ScheduledProcedureStepStartTime));
    assign(scheduled, 'description', getString(step, Tag.ScheduledProcedureStepDescription));
    assign(scheduled, 'step_id', getString(step, Tag.ScheduledProcedureStepID));
    assign(scheduled, 'performing_physician', getPersonName(step, Tag.ScheduledPerformingPhysicianName));
    return scheduled;
}

// Leaves the key off entirely when the RIS returned nothing, so the JSON carries absent
// fields as absent rather than as null.
function assign<T, K extends keyof T>(target: T, key: K, value: T[K] | null): void {
    if (value !== null && value !== undefined) target[key] = value;
}

// DICOM Patient Sex is M, F or O. Anything else (empty, "U", a local code) becomes O
// rather than being passed through to fail validation at the archive.
function normalizeSex(value: string | null): string | null {
    if (!value) return null;
    const upper = value.trim().toUpperCase();
    return upper === 'M' || upper === 'F' ? upper : 'O';
}
