import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsDefined, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { OPERATOR_RELEASE_REASONS, ReleaseReason } from '../../infrastructure/database/entities';

export class ScreeningOrderDto {
    // DICOM SH (16), the same bound the worklist entry carries.
    @IsString() @IsNotEmpty() @MaxLength(16) accession_number!: string;
    @IsString() @Matches(/^[0-9]+(?:\.[0-9]+)*$/) @MaxLength(64) study_instance_uid!: string;
    @IsOptional() @IsString() @IsNotEmpty() @MaxLength(16) step_id?: string;
}
export class RegisterScreeningDto {
    @IsString() @Matches(/^[A-Za-z0-9-]{1,128}$/) id!: string;
    @IsString() @MaxLength(64) @Matches(/^[a-f0-9]{64}$/) source_scope!: string;
    @IsDefined() @ValidateNested() @Type(() => ScreeningOrderDto) order!: ScreeningOrderDto;
    @IsArray() @ArrayNotEmpty() @ArrayMaxSize(1000) @ArrayUnique()
    @IsString({ each: true }) @Matches(/^[A-Za-z0-9-]{1,128}$/, { each: true }) capture_ids!: string[];
}

export class ReleaseScreeningDto {
    @IsIn(OPERATOR_RELEASE_REASONS) reason!: Exclude<ReleaseReason, 'EXPIRED'>;
}
export class ScreeningListQueryDto {
    // all: include released screenings. unfinished: everything not delivered, for the operator page.
    @IsOptional() @IsIn(['all', 'unfinished']) view?: 'all' | 'unfinished';
}
