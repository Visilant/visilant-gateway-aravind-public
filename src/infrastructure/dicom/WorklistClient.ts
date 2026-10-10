import { diagnostics, profile } from '../diagnostics';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Inject, Service } from 'typedi';
import type { MwlNodeConfig } from '../../config';
import { LOGGER } from '../../tokens';
import type { Logger } from '../logger';
import { DicomClient } from './DicomClient';
import { BIN, NETWORK_TIMEOUT_MS } from './dicom.constants';
import { DicomJsonDataset, Tag, toCommandLineTag } from './dicom.tags';

// Tags we ask the RIS to return at the top level of each worklist response.
const RETURN_KEYS = [
    Tag.AccessionNumber,
    Tag.ReferringPhysicianName,
    Tag.PatientName,
    Tag.PatientID,
    Tag.PatientBirthDate,
    Tag.PatientSex,
    Tag.StudyInstanceUID,
    Tag.RequestedProcedureDescription,
    Tag.RequestedProcedureID,
];

// ...and inside the Scheduled Procedure Step Sequence.
const SPS_RETURN_KEYS = [
    Tag.Modality,
    Tag.ScheduledStationAETitle,
    Tag.ScheduledProcedureStepStartDate,
    Tag.ScheduledProcedureStepStartTime,
    Tag.ScheduledPerformingPhysicianName,
    Tag.ScheduledProcedureStepDescription,
    Tag.ScheduledProcedureStepID,
];

export interface WorklistQuery {
    // DICOM DA, or a DA range like "20260101-20260131". Absent means every date — the
    // Aravind MWL holds only open orders, and the pilot never filtered by date.
    scheduledDate?: string;
    patientId?: string;
    accessionNumber?: string;
}

// Reads the modality worklist over C-FIND.
//
// Nothing is persisted: the RIS is the source of truth for what is scheduled, and the
// gateway is a passthrough. `findscu -X` writes each matching response as a file, which
// dcm2json then converts — parsing findscu's own stdout dump is not worth the effort.
@Service()
export class WorklistClient extends DicomClient {
    constructor(@Inject(LOGGER) logger: Logger) {
        super(logger);
    }

    @profile('worklist.query')
    async query(node: MwlNodeConfig, query: WorklistQuery = {}): Promise<DicomJsonDataset[]> {
        // Every response file holds patient demographics, so the whole directory is
        // temporary and removed in the finally below, success or not.
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-mwl-'));

        try {
            await this.run(
                BIN.findscu,
                ['-W', node.host, String(node.port), '-aec', node.called_ae, '-aet', node.calling_ae,
                    ...this.buildKeys(node, query), '-X', '-od', work],
                'C-FIND (worklist)',
                NETWORK_TIMEOUT_MS
            );

            const files = (await fs.readdir(work)).filter((name) => name.endsWith('.dcm')).sort();
            diagnostics.event('worklist.responses', { count: files.length });
            const datasets: DicomJsonDataset[] = [];

            for (const file of files) {
                const json = await this.run(
                    BIN.dcm2json,
                    [path.join(work, file)],
                    'dcm2json',
                    NETWORK_TIMEOUT_MS
                );
                try {
                    datasets.push(JSON.parse(json) as DicomJsonDataset);
                } catch {
                    // One malformed response should not lose the rest of the worklist.
                    // No detail is logged: the payload is PHI.
                    this.logger.error('worklist: discarded a response that was not valid DICOM JSON');
                }
            }

            return datasets;
        } finally {
            await fs.rm(work, { recursive: true, force: true });
        }
    }

    // Matching keys carry a value; return keys are sent empty. Which matching keys a
    // given RIS requires is site-specific, so the procedure ID, modality and station AE
    // come from config rather than being hardcoded.
    private buildKeys(node: MwlNodeConfig, query: WorklistQuery): string[] {
        const keys: string[] = [];
        const add = (tag: string, value?: string) =>
            keys.push('-k', value ? `${toCommandLineTag(tag)}=${value}` : toCommandLineTag(tag));

        const matching: Partial<Record<string, string | undefined>> = {
            [Tag.AccessionNumber]: query.accessionNumber,
            [Tag.PatientID]: query.patientId,
            [Tag.RequestedProcedureID]: node.requested_procedure_id,
        };
        for (const tag of RETURN_KEYS) add(tag, matching[tag]);

        const sps = (tag: string, value?: string) => {
            const key = `${toCommandLineTag(Tag.ScheduledProcedureStepSequence)}[0].${toCommandLineTag(tag)}`;
            keys.push('-k', value ? `${key}=${value}` : key);
        };

        sps(Tag.Modality, node.modality);
        sps(Tag.ScheduledStationAETitle, node.scheduled_station_ae);
        sps(Tag.ScheduledProcedureStepStartDate, query.scheduledDate);
        for (const tag of SPS_RETURN_KEYS) {
            if (tag !== Tag.Modality && tag !== Tag.ScheduledStationAETitle &&
                tag !== Tag.ScheduledProcedureStepStartDate) sps(tag);
        }

        return keys;
    }
}
