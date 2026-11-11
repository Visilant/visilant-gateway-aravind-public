import { Type } from 'class-transformer';
import {
    ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import type { PhoneCounts } from '../../infrastructure/diagnostics/phoneStore';
import type { AssessmentSummary, DetectorSummary, SpanRow } from '../../infrastructure/diagnostics/summary';

// Wire contract for POST /diagnostics/phones/events. Identity is by generated UUID only:
// no field here may carry a patient name, MRN, birth date or accession number. Unknown
// keys are rejected (forbidNonWhitelisted), and free-form attributes are re-filtered by
// safePhoneAttributes before anything is written.

export class PhoneStatusSnapshotDto {
    @IsOptional() @IsNumber() @Min(0) @Max(100)
    battery_level?: number | null;
    @IsOptional() @IsBoolean()
    charging?: boolean | null;
    @IsOptional() @IsNumber() @Min(-20) @Max(100)
    battery_temperature_c?: number | null;
    @IsOptional() @IsBoolean()
    power_save?: boolean | null;
    @IsOptional() @IsInt() @Min(0) @Max(10)
    thermal_status?: number | null;
    @IsOptional() @IsIn(['wifi', 'cellular', 'none', 'other'])
    network_kind?: 'wifi' | 'cellular' | 'none' | 'other' | null;
    @IsOptional() @IsBoolean()
    wifi_connected?: boolean | null;
    @IsOptional() @IsBoolean()
    seeker_connected?: boolean | null;
    @IsOptional() @IsInt() @Min(0)
    seeker_generation?: number | null;
    @IsOptional() @IsInt() @Min(0)
    pending_uploads?: number | null;
    @IsOptional() @IsInt() @Min(0)
    failed_uploads?: number | null;
    @IsOptional() @IsNumber() @Min(0)
    free_storage_bytes?: number | null;
}

export class PhoneEventItemDto {
    @IsIn(['events', 'resources'])
    stream!: 'events' | 'resources';
    @Matches(/^[a-zA-Z0-9_.]{1,80}$/)
    name!: string;
    @IsInt() @Min(0)
    sequence!: number;
    @IsNumber() @Min(0)
    utc_ms!: number;
    @IsNumber() @Min(0)
    monotonic_ms!: number;
    @IsOptional() @IsNumber() @Min(0)
    duration_ms?: number | null;
    @IsIn(['ok', 'error', 'timeout', 'aborted'])
    outcome!: 'ok' | 'error' | 'timeout' | 'aborted';
    @IsOptional() @IsUUID()
    run_id?: string | null;
    @IsOptional() @IsUUID()
    operation_id?: string | null;
    @IsOptional() @IsUUID()
    span_id?: string | null;
    @IsOptional() @IsObject()
    attributes?: Record<string, unknown>;
}

export class PhoneCrashItemDto {
    @IsUUID()
    crash_id!: string;
    @IsIn(['js', 'native'])
    source!: 'js' | 'native';
    @IsNumber() @Min(0)
    utc_ms!: number;
    @IsString() @MaxLength(120) @Matches(/^[A-Za-z0-9_.$:-]{1,120}$/)
    error_type!: string;
    /** Sanitized error code or short non-PHI summary (never raw patient input). */
    @IsString() @MaxLength(240)
    message!: string;
    /** Up to 40 stack frames, each max 200 ASCII chars (file/method/line only). */
    @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(200, { each: true })
    stack!: string[];
    @IsOptional() @Matches(/^[A-Za-z0-9_/-]{1,80}$/)
    route?: string | null;
    @IsOptional() @IsUUID()
    run_id?: string | null;
    @IsOptional() @IsUUID()
    operation_id?: string | null;
    @IsOptional() @IsString() @MaxLength(32) @Matches(/^[A-Za-z0-9_ .:+/(),-]{1,32}$/)
    app_version?: string | null;
    @IsOptional() @ValidateNested() @Type(() => PhoneStatusSnapshotDto)
    device_state?: PhoneStatusSnapshotDto | null;
}

export class PhoneBatchDto {
    @IsUUID()
    device_id!: string;
    @IsUUID()
    batch_id!: string;
    @IsString() @MaxLength(64) @Matches(/^[A-Za-z0-9_ .:+/(),'-]{1,64}$/)
    manufacturer!: string;
    @IsString() @MaxLength(64) @Matches(/^[A-Za-z0-9_ .:+/(),'-]{1,64}$/)
    device_model!: string;
    @IsString() @MaxLength(32) @Matches(/^[A-Za-z0-9_ .:+/(),-]{1,32}$/)
    android_version!: string;
    @IsInt() @Min(21)
    api_level!: number;
    @IsString() @MaxLength(32) @Matches(/^[A-Za-z0-9_ .:+/(),-]{1,32}$/)
    app_version!: string;
    @IsOptional() @IsString() @MaxLength(64) @Matches(/^[A-Za-z0-9._-]{1,64}$/)
    model_revision?: string | null;
    @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/)
    model_manifest_sha256?: string | null;
    @IsOptional() @ValidateNested() @Type(() => PhoneStatusSnapshotDto)
    status?: PhoneStatusSnapshotDto | null;
    @IsDefined() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PhoneEventItemDto)
    events!: PhoneEventItemDto[];
    @IsDefined() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PhoneCrashItemDto)
    crashes!: PhoneCrashItemDto[];
}

// Responses.

export type PhoneStatus = Omit<PhoneStatusSnapshotDto, never>;
export type PhoneAttributes = Record<string, string | number | boolean | null>;

export interface PhoneIngestResultDto { accepted_events: number; accepted_crashes: number; duplicate_batch: boolean }

export interface PhoneSummaryDto {
    device_id: string;
    manufacturer: string;
    device_model: string;
    android_version: string;
    api_level: number;
    app_version: string;
    model_revision: string | null;
    first_seen_at: string;
    last_seen_at: string;
    status: PhoneStatus | null;
    counts: PhoneCounts;
}

export interface PhoneEventRowDto {
    stream: 'events' | 'resources';
    name: string;
    sequence: number;
    utc_ms: number;
    duration_ms: number | null;
    outcome: string;
    run_id: string | null;
    operation_id: string | null;
    span_id: string | null;
    attributes: PhoneAttributes;
}

export interface PhoneCrashRowDto {
    crash_id: string;
    source: 'js' | 'native';
    utc_ms: number;
    error_type: string;
    message: string;
    stack: string[];
    route: string | null;
    run_id: string | null;
    operation_id: string | null;
    device_state: PhoneStatus | null;
    app_version: string | null;
    received_at: string | null;
}

export interface PhoneResourceRowDto {
    name: string;
    utc_ms: number;
    battery_level: number | null;
    battery_temperature_c: number | null;
    thermal_status: number | null;
    cpu_percent: number | null;
    pss_bytes: number | null;
    available_memory_bytes: number | null;
}

export interface PhoneDetailDto {
    phone: PhoneSummaryDto;
    crashes: PhoneCrashRowDto[];
    connectivity: PhoneEventRowDto[];
    captures_and_models: { spans: SpanRow[]; detector: DetectorSummary; assessments: AssessmentSummary };
    recent_events: PhoneEventRowDto[];
    resources: PhoneResourceRowDto[];
    malformed_lines: number;
}
