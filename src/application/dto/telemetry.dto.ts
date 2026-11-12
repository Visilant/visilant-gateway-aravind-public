import { Type, type TypeHelpOptions } from 'class-transformer';
import {
    ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsObject, IsOptional, Matches,
    Max, MaxLength, Min, Validate, ValidateIf, ValidateNested, ValidatorConstraint, type ValidatorConstraintInterface,
} from 'class-validator';
import { LIGHT_MODES } from './capture.dto';

// Phone telemetry, schema version 1. See docs/telemetry.md and docs/api.md.
//
// Allow-list, not scrubbing: every field is a closed enum, a number, a UUID, a version
// or an error code. There is no free-text field, so there is nothing that could carry a
// patient name. Unknown types and unknown keys are rejected.

export const MAX_EVENTS_PER_REQUEST = 100;
export const MAX_BODY_BYTES = 256 * 1024;
// Requests without a valid token, per client IP.
export const ANONYMOUS_REQUESTS_PER_MINUTE = 30;

export const PHONE_EVENT_TYPES = [
    'app.started', 'app.crashed', 'operation.failed', 'capture.taken', 'capture.uploaded', 'capture.upload_failed',
    'yolo.autocapture', 'device.health', 'gateway.unreachable',
] as const;
export type PhoneEventType = typeof PHONE_EVENT_TYPES[number];

// What a phone can emit before anyone signs in. Every other phone type needs a
// signed-in request.
export const PRE_SIGN_IN_EVENT_TYPES: readonly PhoneEventType[] = [
    'app.started', 'app.crashed', 'operation.failed', 'device.health', 'gateway.unreachable',
];

// Written by the gateway itself, never accepted from a phone.
export const GATEWAY_EVENT_TYPES = [
    'gateway.started', 'gateway.heartbeat', 'gateway.stopped', 'gateway.unclean_shutdown', 'ai.assessed',
] as const;
export type GatewayEventType = typeof GATEWAY_EVENT_TYPES[number];

const CAPTURE_EVENTS: readonly string[] = ['capture.taken', 'capture.uploaded', 'capture.upload_failed'];

// Lowercase only, so that one event cannot be stored twice under two spellings.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Same format as the screening and capture ids the app already sends.
const LOCAL_ID = /^[A-Za-z0-9-]{1,128}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEVICE_MODEL = /^[A-Za-z0-9 ._()+-]{1,64}$/;
const JAVA_CLASS = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const JAVA_METHOD = /^(<init>|<clinit>|[A-Za-z_$][\w$]*)$/;
const SOURCE_FILE = /^[A-Za-z0-9_$-]{1,128}\.(kt|java)$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;

@ValidatorConstraint({ name: 'utcTimestamp', async: false })
class UtcTimestamp implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
        const time = Date.parse(value);
        // Date.parse rolls 2026-02-30 over to March; comparing the date part catches it.
        return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
    }
    defaultMessage(): string { return '$property must be an ISO 8601 UTC timestamp, for example 2026-11-12T03:10:00.000Z'; }
}

// ---- payloads, one per type -------------------------------------------------------

export class AppStartedPayload {
    @Matches(VERSION) app_version!: string;
    @Matches(VERSION) android_version!: string;
    @IsOptional() @IsInt() @Min(1) @Max(1000) android_sdk?: number;
    @Matches(DEVICE_MODEL) device_model!: string;
    @IsOptional() @Matches(VERSION) ai_model_revision?: string;
    @IsOptional() @Matches(SHA256) ai_model_manifest_sha256?: string;
    @IsOptional() @Matches(VERSION) yolo_model_revision?: string;
}

// Code-only frames: the exception message is never sent, because it can hold a name.
export class StackFrame {
    @Matches(JAVA_CLASS) @MaxLength(256) class!: string;
    @Matches(JAVA_METHOD) @MaxLength(128) method!: string;
    @Matches(SOURCE_FILE) file!: string;
    @IsOptional() @IsInt() @Min(0) line?: number;
}

export class AppCrashedPayload {
    // uncaught_handler: sent from the crash handler. exit_info: read on the next launch
    // from Android's ApplicationExitInfo.
    @IsIn(['uncaught_handler', 'exit_info']) source!: string;
    @Matches(VERSION) app_version!: string;
    @IsOptional() @Matches(CODE) error_code?: string;
    @IsOptional() @Matches(JAVA_CLASS) @MaxLength(256) exception_class?: string;
    // ApplicationExitInfo reason, for example crash, anr or low_memory.
    @IsOptional() @Matches(CODE) exit_reason?: string;
    // For exit_info: the session that crashed. session_id is the launch reporting it.
    @IsOptional() @Matches(UUID) crashed_session_id?: string;
    @IsOptional() @IsArray() @ArrayMaxSize(64) @ValidateNested({ each: true }) @Type(() => StackFrame)
    stack_frames?: StackFrame[];
}

export class OperationFailedPayload {
    @Matches(CODE) operation!: string;
    @Matches(CODE) error_code!: string;
}

export class CaptureTakenPayload {
    @IsIn(LIGHT_MODES) light!: string;
    @IsIn(['L', 'R']) eye!: string;
    @IsIn(['autocapture', 'manual']) mode!: string;
}

export class CaptureUploadedPayload {
    @IsInt() @Min(0) duration_ms!: number;
    @IsInt() @Min(0) bytes!: number;
    @IsInt() @Min(100) @Max(599) http_status!: number;
}

export class CaptureUploadFailedPayload {
    @IsInt() @Min(0) duration_ms!: number;
    @IsOptional() @IsInt() @Min(0) bytes?: number;
    @IsOptional() @IsInt() @Min(100) @Max(599) http_status?: number;
    @IsOptional() @Matches(CODE) error_code?: string;
}

// Normalised to the frame: 0 to 1 on each axis.
export class DetectionBox {
    @IsNumber() @Min(0) @Max(1) x!: number;
    @IsNumber() @Min(0) @Max(1) y!: number;
    @IsNumber() @Min(0) @Max(1) width!: number;
    @IsNumber() @Min(0) @Max(1) height!: number;
}

// Frames rejected, by reason, in the order EyeDetectionEngine checks them.
export class RejectedFrames {
    @IsOptional() @IsInt() @Min(0) no_eye?: number;
    @IsOptional() @IsInt() @Min(0) clipped?: number;
    @IsOptional() @IsInt() @Min(0) too_close?: number;
    @IsOptional() @IsInt() @Min(0) too_far?: number;
    @IsOptional() @IsInt() @Min(0) off_centre?: number;
    @IsOptional() @IsInt() @Min(0) no_iris?: number;
    @IsOptional() @IsInt() @Min(0) gaze_off?: number;
    @IsOptional() @IsInt() @Min(0) hold_broken?: number;
}

export class YoloAutocapturePayload {
    @IsIn(['fired', 'timed_out', 'cancelled']) outcome!: string;
    @IsInt() @Min(0) frames_evaluated!: number;
    @IsOptional() @IsInt() @Min(0) time_to_trigger_ms?: number;
    @IsOptional() @IsDefined() @ValidateNested() @Type(() => DetectionBox) winning_box?: DetectionBox;
    @IsOptional() @IsNumber() @Min(0) @Max(1) winning_score?: number;
    @IsDefined() @ValidateNested() @Type(() => RejectedFrames) rejected_frames!: RejectedFrames;
    @IsOptional() @IsIn(['kept', 'retook']) operator_decision?: string;
    @Matches(VERSION) yolo_model_revision!: string;
}

export class DeviceHealthPayload {
    @IsInt() @Min(0) @Max(100) battery_pct!: number;
    @IsBoolean() charging!: boolean;
    @IsOptional() @IsNumber() @Min(-40) @Max(120) battery_temp_c?: number;
    // Android PowerManager thermal status.
    @IsOptional() @IsIn(['none', 'light', 'moderate', 'severe', 'critical', 'emergency', 'shutdown']) thermal_status?: string;
    @IsInt() @Min(0) free_storage_bytes!: number;
    @IsIn(['wifi', 'cellular', 'ethernet', 'none', 'other']) network_kind!: string;
    @IsOptional() @IsInt() @Min(-127) @Max(0) wifi_rssi_dbm?: number;
    @IsBoolean() seeker_connected!: boolean;
}

// Events the phone counted and discarded while it could not reach the gateway.
export class DroppedCounts {
    @IsOptional() @IsInt() @Min(0) 'app.started'?: number;
    @IsOptional() @IsInt() @Min(0) 'app.crashed'?: number;
    @IsOptional() @IsInt() @Min(0) 'operation.failed'?: number;
    @IsOptional() @IsInt() @Min(0) 'capture.taken'?: number;
    @IsOptional() @IsInt() @Min(0) 'capture.uploaded'?: number;
    @IsOptional() @IsInt() @Min(0) 'capture.upload_failed'?: number;
    @IsOptional() @IsInt() @Min(0) 'yolo.autocapture'?: number;
    @IsOptional() @IsInt() @Min(0) 'device.health'?: number;
}

export class GatewayUnreachablePayload {
    @Validate(UtcTimestamp) from!: string;
    @Validate(UtcTimestamp) to!: string;
    @IsDefined() @ValidateNested() @Type(() => DroppedCounts) dropped!: DroppedCounts;
}

// Takes the payload of an unknown type. Its type has already failed, and with no
// properties every payload key is also reported as unknown.
class UnknownPayload {}

const PAYLOAD_CLASSES: Record<PhoneEventType, new () => object> = {
    'app.started': AppStartedPayload,
    'app.crashed': AppCrashedPayload,
    'operation.failed': OperationFailedPayload,
    'capture.taken': CaptureTakenPayload,
    'capture.uploaded': CaptureUploadedPayload,
    'capture.upload_failed': CaptureUploadFailedPayload,
    'yolo.autocapture': YoloAutocapturePayload,
    'device.health': DeviceHealthPayload,
    'gateway.unreachable': GatewayUnreachablePayload,
};

function payloadClass(options?: TypeHelpOptions): new () => object {
    const type = (options?.object as { type?: unknown } | undefined)?.type;
    return typeof type === 'string' && Object.prototype.hasOwnProperty.call(PAYLOAD_CLASSES, type) ? PAYLOAD_CLASSES[type as PhoneEventType] : UnknownPayload;
}

// ---- envelope ---------------------------------------------------------------------

// One phone event. The gateway adds received_at, site_id and gateway_id.
export class TelemetryEventDto {
    @Matches(UUID_V7, { message: 'event_id must be a lowercase UUIDv7' })
    event_id!: string;

    @IsInt() @IsIn([1])
    schema_version!: number;

    @IsIn(PHONE_EVENT_TYPES)
    type!: PhoneEventType;

    @Validate(UtcTimestamp)
    occurred_at!: string;

    @Matches(UUID, { message: 'device_id must be a lowercase UUID' })
    device_id!: string;

    @Matches(UUID, { message: 'session_id must be a lowercase UUID' })
    session_id!: string;

    // Required on capture.* events; optional, but checked, everywhere else.
    @ValidateIf((o: TelemetryEventDto) => CAPTURE_EVENTS.includes(o.type) || (o.capture_id !== undefined && o.capture_id !== null))
    @Matches(LOCAL_ID)
    capture_id?: string | null;

    @ValidateIf((o: TelemetryEventDto) => o.screening_id !== undefined && o.screening_id !== null)
    @Matches(LOCAL_ID)
    screening_id?: string | null;

    @IsDefined() @IsObject() @ValidateNested() @Type(payloadClass)
    payload!: object;
}

export class TelemetryBatchDto {
    @IsArray() @ArrayNotEmpty() @ArrayMaxSize(MAX_EVENTS_PER_REQUEST)
    @ValidateNested({ each: true }) @Type(() => TelemetryEventDto)
    events!: TelemetryEventDto[];
}

export class TelemetryIngestResultDto {
    accepted!: string[];
    duplicate!: string[];
    // Not stored because the outbox is full of unsent rows (device.health only).
    dropped!: string[];
}

export class TelemetryExportQueryDto {
    @IsOptional()
    @Matches(UUID, { message: 'since must be a lowercase event_id' })
    since?: string;
}
