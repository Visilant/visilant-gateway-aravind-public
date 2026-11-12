import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsDefined,
    IsIn,
    IsOptional,
    IsInt,
    IsNotEmpty,
    IsPositive,
    IsNumber,
    IsString,
    IsUrl,
    Matches,
    MaxLength,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator';

export type Retention = 'DELETE_ON_SENT' | 'KEEP';

// A DICOM node we talk to. MWL (worklist source) and store (archive) are modelled
// separately on purpose — they are frequently different AEs on different hosts.
export class DicomNodeConfig {
    @IsString()
    @IsNotEmpty()
    host!: string;

    @IsInt()
    @IsPositive()
    port!: number;

    // AE titles are capped at 16 characters by the DICOM standard. A longer one is
    // rejected by the peer at association time, which is a much worse place to find out.
    @IsString()
    @IsNotEmpty()
    @MaxLength(16)
    called_ae!: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(16)
    calling_ae!: string;
}

// The MWL node additionally carries the matching keys the query is filtered by. They
// are config rather than constants, so a centre that filters differently is an edit to
// config.json, not a release.
export class MwlNodeConfig extends DicomNodeConfig {
    // (0040,1001) — the procedure ID the RIS schedules anterior segment imaging under.
    // This is the filter the Aravind pilot used, and the only one it used: without it
    // the worklist returns every open order at the centre, for every modality.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(16)
    requested_procedure_id?: string;

    // (0008,0060) — OP is Ophthalmic Photography. Omit to match any modality.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    modality?: string;

    // (0040,0001) — restricts the worklist to steps scheduled for this station.
    // Omit to receive every scheduled step regardless of station.
    @IsOptional()
    @IsString()
    @MaxLength(16)
    scheduled_station_ae?: string;
}

// Telemetry from phones and from the gateway itself, kept in a SQLite outbox and pushed
// to the central store. See docs/telemetry.md. Off unless a site turns it on.
export class TelemetryConfig {
    // Off: POST /telemetry/events answers 204 and nothing is written, the gateway writes
    // none of its own events, and nothing is pushed.
    @IsBoolean()
    enabled: boolean = false;

    // The vision centre ID. Every row carries it, and central combines sites by it, so a
    // gateway with telemetry on and no site_id refuses to start.
    @ValidateIf((o: TelemetryConfig) => o.enabled || o.site_id !== undefined)
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'site_id must be 1 to 64 letters, digits, _ or -' })
    site_id?: string;

    // The central receiver, without the /v1/telemetry/batch path. Without central_url and
    // central_token rows stay in the outbox and can still be exported.
    @ValidateIf((o: TelemetryConfig) => o.central_url !== undefined || o.central_token !== undefined)
    @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false }, { message: 'central_url must be an http or https URL' })
    central_url?: string;

    // Per-gateway bearer token for central. Never returned by GET /system/config.
    @ValidateIf((o: TelemetryConfig) => o.central_url !== undefined || o.central_token !== undefined)
    @IsString()
    @IsNotEmpty()
    central_token?: string;

    // Sent rows are pruned oldest first above this size or this age. Unsent rows are
    // never pruned; when they alone pass the cap the gateway stops taking device.health.
    @IsNumber()
    @IsPositive()
    max_outbox_mb: number = 200;

    @IsInt()
    @IsPositive()
    retention_days: number = 90;
}

export class GatewayConfig {
    // Identifies this centre. Pinned into the JWT payload as tenant_id so the app,
    // which sends x-tenant-id on every request, needs no change.
    @IsString()
    @IsNotEmpty()
    centre_code!: string;

    @IsInt()
    @IsPositive()
    listen_port: number = 8080;

    // Where built DICOM objects wait for their C-STORE, and where the database lives.
    @IsString()
    @IsNotEmpty()
    storage_root!: string;

    @IsString()
    @IsNotEmpty()
    database_path!: string;

    // Whether the .dcm is deleted once the archive acknowledges it. Under KEEP the
    // RetentionService keeps the files of the newest retention_keep_count sent captures
    // and removes older sent files; rows are never removed.
    @IsIn(['DELETE_ON_SENT', 'KEEP'])
    retention: Retention = 'KEEP';

    // How many sent captures keep their file under KEEP. Older sent files are removed
    // after each successful send and once at boot.
    @IsInt()
    @IsPositive()
    retention_keep_count: number = 10;

    // Root OID for the UIDs we mint: series and SOP instance always, and the Study
    // Instance UID only when a worklist entry arrives without one.
    @IsString()
    @IsNotEmpty()
    study_uid_root!: string;

    // How often the worker drains the queue. A capture is also attempted the moment it
    // is queued (send_immediately), so this is the retry cadence, not the normal path.
    @IsInt()
    @IsPositive()
    sync_interval_seconds: number = 30;

    // Send each capture as soon as it is queued instead of waiting for the next tick.
    @IsBoolean()
    send_immediately: boolean = true;

    // Attempts before a capture is parked as FAILED. With the capped backoff this is
    // roughly nine hours — long enough to ride out an archive outage, short enough that
    // a genuinely broken object surfaces the same day instead of retrying forever.
    @IsInt()
    @IsPositive()
    max_send_attempts: number = 20;

    // Days a screening that cannot finish (images missing, or a capture parked as FAILED)
    // may sit untouched before the gateway releases it on its own, returning its order to
    // the worklist. Nothing is deleted. 0 turns this off and leaves release to an operator.
    @IsInt()
    @Min(0)
    screening_expiry_days: number = 7;

    // @ValidateNested is silent on an absent property, so @IsDefined does the presence
    // check. Without it a config missing an entire node validates here and fails later
    // at the first association, far from the cause.
    @IsDefined()
    @ValidateNested()
    @Type(() => MwlNodeConfig)
    mwl!: MwlNodeConfig;

    @IsDefined()
    @ValidateNested()
    @Type(() => DicomNodeConfig)
    store!: DicomNodeConfig;

    // Optional block: a config without it has telemetry off.
    @IsDefined()
    @ValidateNested()
    @Type(() => TelemetryConfig)
    telemetry: TelemetryConfig = new TelemetryConfig();
}
