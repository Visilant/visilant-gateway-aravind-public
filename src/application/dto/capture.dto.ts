import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { isAiAssessment, type AiAssessment } from '../../domain/assessment';
import { CaptureStatus } from '../../infrastructure/database';
import type { CaptureTags } from '../../infrastructure/dicom';
import { WorklistEntryDto } from './worklist.dto';

const LATERALITIES = ['L', 'R'] as const;
export type Laterality = typeof LATERALITIES[number];

// The light the photograph was taken under — the app's EyeFilter.
export const LIGHT_MODES = ['WHITE', 'BLUE', 'SLIT'] as const;
export type LightMode = typeof LIGHT_MODES[number];

@ValidatorConstraint({ name: 'whiteAssessment', async: false })
class WhiteAssessment implements ValidatorConstraintInterface {
    validate(value: unknown, args: ValidationArguments): boolean {
        return value === undefined || ((args.object as CreateCaptureDto).light === 'WHITE' && isAiAssessment(value));
    }
    defaultMessage(): string { return 'ai_assessment requires WHITE light and a valid assessment'; }
}
// What the app posts alongside the JPEG.
//
// The worklist entry travels WITH the capture rather than being looked up again at send
// time. A RIS removes a worklist entry once the procedure is marked performed, so a
// queue that drained hours later — after a night with the archive unreachable — would
// find nothing to build the object from.
export class CreateCaptureDto {
    // Registered screening this capture belongs to; same format as RegisterScreeningDto.id.
    @IsOptional() @IsString() @Matches(/^[A-Za-z0-9-]{1,128}$/)
    screening_id?: string;

    @Validate(WhiteAssessment)
    ai_assessment?: AiAssessment;

    @IsDefined()
    @ValidateNested()
    @Type(() => WorklistEntryDto)
    worklist_entry!: WorklistEntryDto;

    // Image Laterality (0020,0062). Type 1 for Ophthalmic Photography: every image must
    // say which eye it is of. The app already captures per eye.
    @IsIn(LATERALITIES)
    laterality!: Laterality;

    // Drives the illumination and light-path filter codes. Optional because a capture
    // without it is still a valid image; we leave those codes out rather than guess.
    @IsOptional()
    @IsIn(LIGHT_MODES)
    light?: LightMode;

    // Pupil Dilated (0022,000D), DICOM-native YES/NO. Written empty when not supplied.
    @IsOptional()
    @IsIn(['YES', 'NO'])
    pupil_dilated?: string;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    series_description?: string;
}

export class CaptureCreatedDto {
    id!: string;
    status!: string;
    study_instance_uid!: string;
    series_instance_uid!: string;
    sop_instance_uid!: string;
    accession_number!: string;
}

export class CaptureListQueryDto {
    @IsOptional()
    @IsIn(Object.values(CaptureStatus))
    status?: CaptureStatus;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(/^\d+(\.\d+)*$/)
    study_instance_uid?: string;
}

export interface CaptureRowDto {
    id: string; client_capture_id: string | null; status: CaptureStatus;
    study_instance_uid: string; series_instance_uid: string; sop_instance_uid: string;
    accession_number: string; attempts: number; next_attempt_at: string | null;
    last_error: string | null; created_by: string | null; created_at: string; sent_at: string | null;
    diagnostic_run_id: string | null; diagnostic_operation_id: string | null; enqueued_at: string | null;
    file_present: boolean;
}
export type CaptureTagsDto = CaptureTags;
