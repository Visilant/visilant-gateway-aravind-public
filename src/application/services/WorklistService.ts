import { ScreeningService } from './ScreeningService';
import { profile } from '../../infrastructure/diagnostics';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
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
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly worklistClient: WorklistClient,
        private readonly screenings: ScreeningService,
    ) {}

    @profile('worklist.getWorklist')
    async getWorklist(query: WorklistQueryDto = {}): Promise<WorklistEntryDto[]> {
        const datasets = await this.worklistClient.query(this.config.mwl, {
            // No date unless the caller asks for one. The MWL holds open orders only and
            // the configured procedure ID already narrows it; a today-only default would
            // hide an order booked yesterday that the patient is sitting in front of now.
            scheduledDate: query.date,
            patientId: query.patient_id,
            accessionNumber: query.accession_number,
        });

        const entries: WorklistEntryDto[] = [];
        let unusable = 0;

        for (const dataset of datasets) {
            const steps = getSequence(dataset, Tag.ScheduledProcedureStepSequence);
            for (const step of steps.length ? steps : [undefined]) {
                const entry = this.toEntry(dataset, step);
                if (entry) entries.push(entry);
                else unusable++;
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

        return this.screenings.filter(entries);
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
