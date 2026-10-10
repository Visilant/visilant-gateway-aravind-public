import { diagnosticContext, diagnostics, profile } from '../../infrastructure/diagnostics';
import { promises as fs } from 'fs';
import { Inject, Service } from 'typedi';
import { v4 as uuidv4 } from 'uuid';
import type { GatewayConfig } from '../../config';
import { CaptureEntity, CaptureStatus } from '../../infrastructure/database';
import { CaptureRepository } from '../../infrastructure/database/repositories';
import {
    BLUE_FILTER,
    DIFFUSE_ILLUMINATION,
    DicomBuilder,
    DicomImageTags,
    NO_FILTER,
    SLIT_ILLUMINATION,
    deriveUid,
} from '../../infrastructure/dicom';
import type { Logger } from '../../infrastructure/logger';
import { LocalDiskStorage } from '../../infrastructure/storage';
import { CONFIG, LOGGER } from '../../tokens';
import { CaptureCreatedDto, CaptureListQueryDto, CaptureRowDto, CreateCaptureDto, WorklistEntryDto } from '../dto';
import { LIGHT_MODES, Laterality, LightMode } from '../dto/capture.dto';
import { ScreeningService } from './ScreeningService';
import { SyncWorker } from './SyncWorker';

@Service()
export class CaptureService {
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly captureRepository: CaptureRepository,
        private readonly dicomBuilder: DicomBuilder,
        private readonly storage: LocalDiskStorage,
        private readonly syncWorker: SyncWorker,
        private readonly screenings: ScreeningService,
    ) {}

    async list(query: CaptureListQueryDto): Promise<CaptureRowDto[]> {
        let rows = query.study_instance_uid
            ? await this.captureRepository.findByStudy(query.study_instance_uid, 100)
            : query.status ? await this.captureRepository.findByStatus(query.status) : await this.captureRepository.findRecent();
        if (query.status && query.study_instance_uid) rows = rows.filter(row => row.status === query.status);
        return Promise.all(rows.map(row => this.toRow(row)));
    }

    async get(id: string): Promise<CaptureRowDto | null> {
        const row = await this.captureRepository.findById(id);
        return row ? this.toRow(row) : null;
    }

    private async toRow(row: CaptureEntity): Promise<CaptureRowDto> {
        return {
            id: row.id, client_capture_id: row.client_capture_id, status: row.status,
            study_instance_uid: row.study_instance_uid, series_instance_uid: row.series_instance_uid,
            sop_instance_uid: row.sop_instance_uid, accession_number: row.accession_number,
            attempts: row.attempts, next_attempt_at: row.next_attempt_at, last_error: row.last_error,
            created_by: row.created_by, created_at: row.created_at, sent_at: row.sent_at,
            diagnostic_run_id: row.diagnostic_run_id, diagnostic_operation_id: row.diagnostic_operation_id,
            enqueued_at: row.enqueued_at, file_present: await this.storage.exists(row.dicom_path),
        };
    }

    // Converts the capture to DICOM and queues it. The archive is not contacted here:
    // the operator should not wait on the network, and a PACS that is briefly down must
    // not cost a photograph that has already been taken.
    @profile('capture.create')
    async create(
        input: CreateCaptureDto, uploadPath: string, createdBy: string | null,
        clientCaptureId: string | null = null,
    ): Promise<CaptureCreatedDto> {
        if (clientCaptureId !== null) {
            const existing = await this.captureRepository.findByClientId(clientCaptureId);
            if (existing) {
                await fs.rm(uploadPath, { force: true }).catch(() => undefined);
                diagnostics.event('capture.duplicate', { duplicates: 1 });
                return this.toDto(existing);
            }
        }
        // After the replay lookup: a retry of a capture already accepted gets its original
        // answer, never a 400 because something about the order has changed since.
        await this.screenings.validateCapture(input.screening_id, clientCaptureId, input.worklist_entry);
        const entry = input.worklist_entry;
        const id = uuidv4();
        const capturedAt = new Date();

        // One series per eye and light mode within the study, so a viewer groups
        // "right eye, slit" together rather than showing every photograph as one stack.
        // Derived, not random: every capture of that eye under that light joins it.
        const seriesUid = deriveUid(
            `series:${entry.study_instance_uid}:${input.laterality}:${input.light ?? 'NONE'}`,
            this.config.study_uid_root
        );
        const sopUid = deriveUid(`instance:${clientCaptureId ?? id}`, this.config.study_uid_root);
        const objectKey = `${sanitize(entry.accession_number)}/${id}.dcm`;

        // Not atomic with the insert below, so two captures racing into the same series
        // can share a number. Instance Number is a display ordering, not an identifier —
        // the SOP Instance UID is what keeps them distinct.
        const instanceNumber = (await this.captureRepository.countInSeries(seriesUid)) + 1;

        const target = await this.storage.ensureDirectory(objectKey);

        try {
            await this.dicomBuilder.build(
                uploadPath,
                this.toTags(entry, input, seriesUid, sopUid, instanceNumber, capturedAt),
                target
            );
        } catch (err) {
            // Conversion can fail after producing a partial object. It has no row.
            await this.storage.remove(objectKey).catch(() => undefined);
            throw err;
        } finally {
            // The multer upload is a copy of the photograph, so it goes whether the
            // conversion succeeded or not.
            await fs.rm(uploadPath, { force: true }).catch(() => undefined);
        }

        let capture: CaptureEntity;
        try {
            capture = await this.captureRepository.create({
                id,
                diagnostic_run_id: diagnosticContext.getStore()?.run_id ?? null,
                diagnostic_operation_id: diagnosticContext.getStore()?.operation_id ?? null,
                enqueued_at: new Date().toISOString(),
                client_capture_id: clientCaptureId,
                screening_id: input.screening_id ?? null,
                dicom_path: objectKey,
                status: CaptureStatus.PENDING,
                study_instance_uid: entry.study_instance_uid,
                series_instance_uid: seriesUid,
                sop_instance_uid: sopUid,
                accession_number: entry.accession_number,
                attempts: 0,
                next_attempt_at: null,
                last_error: null,
                created_by: createdBy,
                created_at: capturedAt.toISOString(),
                sent_at: null,
            });
        } catch (err) {
            // No row means nothing will ever send this file, so it would sit on disk
            // holding PHI forever. Remove it rather than leak it.
            await this.storage.remove(objectKey).catch(() => undefined);
            // SQLite may report the SOP UID constraint first: that UID is also
            // deterministic for the client key. Never recover unrelated failures.
            if (clientCaptureId !== null && err instanceof Error &&
                /UNIQUE constraint failed: capture\.(client_capture_id|sop_instance_uid)/.test(err.message)) {
                const winner = await this.captureRepository.findByClientId(clientCaptureId);
                if (winner) return this.toDto(winner);
            }
            throw err;
        }

        diagnostics.event('capture.queued');
        // Bookkeeping for the inactivity backstop. The capture is already durable, so a
        // failure here must not turn its upload into an error.
        await this.screenings.touch(capture.screening_id).catch((err: unknown) => {
            this.logger.warn(`could not record activity for capture ${capture.id}; screening expiry may run early: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        });

        this.logger.info(`capture ${capture.id} queued`);

        // Send now rather than at the next interval. Deliberately not awaited: the
        // operator's response should not wait on the archive, and the row is already
        // durable — if this attempt fails the queue retries it with backoff.
        if (this.config.send_immediately) {
            void this.syncWorker.tick().catch((err: unknown) => {
                this.logger.error(
                    `immediate send failed for capture ${capture.id}, leaving it queued: ` +
                    `${err instanceof Error ? err.message : String(err)}`
                );
            });
        }

        return this.toDto(capture);
    }

    // Operator retry of a parked capture. Counts as activity on its screening, so the
    // inactivity backstop does not release a screening someone is working on.
    async retry(id: string): Promise<{ id: string; status: string } | null> {
        const capture = await this.captureRepository.findById(id);
        if (!capture) return null;
        await this.captureRepository.requeue(id);
        await this.screenings.touch(capture.screening_id);
        const current = await this.captureRepository.findById(id);
        return { id, status: current?.status ?? capture.status };
    }

    private toDto(capture: CaptureEntity): CaptureCreatedDto {
        return {
            id: capture.id,
            status: capture.status,
            study_instance_uid: capture.study_instance_uid,
            series_instance_uid: capture.series_instance_uid,
            sop_instance_uid: capture.sop_instance_uid,
            accession_number: capture.accession_number,
        };
    }

    // Mapping follows the Aravind pilot (§5a) with one change: where the pilot invented
    // demographics for a missing value ("Unknown", 20000101, F) we leave the attribute
    // empty. A made-up birth date or sex on a clinical image is worse than none.
    private toTags(
        entry: WorklistEntryDto,
        input: CreateCaptureDto,
        seriesUid: string,
        sopUid: string,
        instanceNumber: number,
        capturedAt: Date,
    ): DicomImageTags {
        const light = input.light;
        return {
            patientName: entry.patient_name,
            patientId: entry.patient_id,
            patientBirthDate: entry.patient_birth_date,
            patientSex: entry.patient_sex,
            // Straight from the worklist. Deriving one here would file the image under a
            // study the RIS never ordered.
            studyInstanceUid: entry.study_instance_uid,
            seriesInstanceUid: seriesUid,
            sopInstanceUid: sopUid,
            accessionNumber: entry.accession_number,
            // Study ID is a short site identifier. The accession is stable across every
            // capture for the order, where the pilot's random ID differed per image.
            studyId: entry.accession_number,
            studyDate: entry.scheduled?.start_date ?? toDA(capturedAt),
            studyTime: entry.scheduled?.start_time ?? toTM(capturedAt),
            referringPhysician: entry.referring_physician,
            studyDescription: entry.requested_procedure_description,
            seriesDescription: input.series_description ?? describeSeries(input.laterality, light),
            seriesNumber: seriesNumber(input.laterality, light),
            instanceNumber,
            laterality: input.laterality,
            pupilDilated: input.pupil_dilated,
            aiAssessment: input.ai_assessment,
            captureLight: input.light,
            illumination: light ? (light === 'SLIT' ? SLIT_ILLUMINATION : DIFFUSE_ILLUMINATION) : undefined,
            lightPathFilter: light ? (light === 'BLUE' ? BLUE_FILTER : NO_FILTER) : undefined,
        };
    }
}

// The accession becomes a directory name, so anything that could climb out of the
// storage root or is invalid on NTFS is replaced.
function sanitize(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

// Stable per eye and light, so the same series always carries the same number:
// right eye 1-4, left eye 5-8, in the order white, blue, slit, unspecified.
function seriesNumber(laterality: Laterality, light: LightMode | undefined): number {
    const index = light ? LIGHT_MODES.indexOf(light) : LIGHT_MODES.length;
    return (laterality === 'R' ? 0 : LIGHT_MODES.length + 1) + index + 1;
}

function describeSeries(laterality: Laterality, light: LightMode | undefined): string {
    const eye = laterality === 'R' ? 'Right eye' : 'Left eye';
    return light ? `${eye}, ${light.toLowerCase()} light` : eye;
}

// DICOM DA / TM are local time: this box sits in the centre whose clock the RIS uses.
const pad = (n: number) => String(n).padStart(2, '0');

function toDA(date: Date): string {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function toTM(date: Date): string {
    return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
