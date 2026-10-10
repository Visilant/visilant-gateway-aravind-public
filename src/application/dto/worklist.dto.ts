import { Type } from 'class-transformer';
import {
    Allow,
    IsIn,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';

const DICOM_DA = /^\d{8}$/;        // YYYYMMDD
const DICOM_TM = /^\d{6}(\.\d+)?$/; // HHMMSS[.FFFFFF]

export class ScheduledStepDto {
    @IsOptional() @IsString()
    modality?: string;

    @IsOptional() @IsString()
    station_ae?: string;

    @IsOptional() @Matches(DICOM_DA, { message: 'start_date must be a DICOM DA value (YYYYMMDD)' })
    start_date?: string;

    @IsOptional() @Matches(DICOM_TM, { message: 'start_time must be a DICOM TM value (HHMMSS)' })
    start_time?: string;

    @IsOptional() @IsString()
    description?: string;

    // DICOM SH: at most 16 characters. Part of the screening order identity.
    @IsOptional() @IsString() @MaxLength(16)
    step_id?: string;

    @IsOptional() @IsString()
    performing_physician?: string;
}

// One scheduled procedure step, as the app sees it.
//
// Values stay in their DICOM-native form — Person Name stays caret-delimited, dates stay
// DA (YYYYMMDD) — deliberately. The app sends this same object back when it posts a
// capture, and those values are written straight into the DICOM object. Converting to a
// display format here would mean converting back on the way in, and any lossy round trip
// produces an image whose demographics no longer match the order it was taken against.
// Formatting for the screen is the app's job.
export class WorklistEntryDto {
    // Read-only fields the gateway adds to GET /worklist rows. Every installed phone sends
    // the row it received back with its captures, so they are accepted on input and
    // ignored: the gateway decides order identity from the manifest, never from these.
    @IsOptional() @IsString() @MaxLength(64)
    source_scope?: string;

    @Allow()
    submission?: unknown;

    @IsString() @IsNotEmpty() @MaxLength(16)
    accession_number!: string;

    // Assigned by the RIS. The gateway mints one (from the accession) only when the RIS
    // sends none — an image under a different Study UID lands in a different study.
    @IsString() @IsNotEmpty() @MaxLength(64)
    study_instance_uid!: string;

    @IsString() @IsNotEmpty() @MaxLength(64)
    patient_id!: string;

    // Type 2 in DICOM: written empty rather than invented when the RIS has none.
    @IsOptional() @IsString() @MaxLength(64)
    patient_name?: string;

    @IsOptional() @Matches(DICOM_DA, { message: 'patient_birth_date must be a DICOM DA value (YYYYMMDD)' })
    patient_birth_date?: string;

    @IsOptional() @IsIn(['M', 'F', 'O'])
    patient_sex?: string;

    @IsOptional() @IsString()
    referring_physician?: string;

    @IsOptional() @IsString()
    requested_procedure_id?: string;

    @IsOptional() @IsString()
    requested_procedure_description?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => ScheduledStepDto)
    scheduled?: ScheduledStepDto;
}

export class WorklistQueryDto {
    // DICOM DA, or a DA range ("20260101-20260131"). Absent means every scheduled date.
    @IsOptional()
    @Matches(/^(\d{8})(-\d{8})?$|^-\d{8}$|^\d{8}-$/, {
        message: 'date must be a DICOM DA value or range (YYYYMMDD, YYYYMMDD-YYYYMMDD)',
    })
    date?: string;

    @IsOptional() @IsString() @IsNotEmpty()
    patient_id?: string;

    @IsOptional() @IsString() @IsNotEmpty()
    accession_number?: string;
}
