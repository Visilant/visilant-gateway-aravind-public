import path from 'path';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { CaptureRepository, SettingRepository } from '../../infrastructure/database/repositories';
import { DiagnosticRecorder, diagnosticId } from '../../infrastructure/diagnostics';
import { safePhoneAttributes, sanitizeCrashMessage, sanitizeStack } from '../../infrastructure/diagnostics/phoneAttributes';
import { PhoneCounts, PhoneDiagnosticsStore, PhoneManifest, PhoneStatusSnapshot } from '../../infrastructure/diagnostics/phoneStore';
import { DiagnosticsStore, SegmentManifest } from '../../infrastructure/diagnostics/store';
import { assessmentSummary, detectorSummary, eventCounts, isConnectivityEvent, pendingDeliveries, runsSeen, spanRows, SummaryEvent } from '../../infrastructure/diagnostics/summary';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER, RECORDER } from '../../tokens';
import type { CaptureRefDto, RecordingStatus, RunDetailDto, SegmentDetailDto, SegmentDto } from '../dto/diagnostics.dto';
import type {
    PhoneBatchDto, PhoneCrashRowDto, PhoneDetailDto, PhoneEventRowDto, PhoneIngestResultDto, PhoneResourceRowDto, PhoneStatusSnapshotDto, PhoneSummaryDto,
} from '../dto/phone-diagnostics.dto';

export const RECORDING_SETTING = 'diagnostics.recording';
export class RecordingLockedError extends Error { constructor() { super('recording is controlled by GATEWAY_DIAGNOSTICS_DIR on this process'); } }
export class RecordingStartError extends Error { constructor() { super('recording could not be started; see the gateway log'); } }
export class InvalidDiagnosticIdError extends Error { constructor(what: string) { super(`${what} must be a UUID`); } }
export class SegmentNotFoundError extends Error { constructor(id: string) { super(`segment ${id} not found`); } }
export class RunNotFoundError extends Error { constructor(id: string) { super(`run ${id} not found`); } }
export class PhoneNotFoundError extends Error { constructor(id: string) { super(`phone ${id} not found`); } }
function effectiveRoot(config: GatewayConfig): string {
    return process.env.GATEWAY_DIAGNOSTICS_DIR ? path.resolve(process.env.GATEWAY_DIAGNOSTICS_DIR) : path.join(path.resolve(config.storage_root), 'diagnostics');
}

@Service()
export class DiagnosticsService {
    private transition: Promise<unknown> = Promise.resolve();
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly settingRepository: SettingRepository,
        private readonly captureRepository: CaptureRepository,
        @Inject(RECORDER) private readonly recorder: DiagnosticRecorder,
    ) {}

    // Resolve at call time: the environment override is authoritative for every operation.
    private get store(): DiagnosticsStore { return new DiagnosticsStore(effectiveRoot(this.config)); }
    private get phoneStore(): PhoneDiagnosticsStore { return new PhoneDiagnosticsStore(path.join(effectiveRoot(this.config), 'phones')); }
    status(): RecordingStatus {
        return { enabled: this.recorder.enabled, locked_by: process.env.GATEWAY_DIAGNOSTICS_DIR ? 'env' : null, directory: effectiveRoot(this.config) };
    }
    setRecording(enabled: boolean): Promise<RecordingStatus> {
        // Keep overlapping operator requests in durable-setting/recorder order.
        const result = this.transition.then(async () => {
            if (process.env.GATEWAY_DIAGNOSTICS_DIR) throw new RecordingLockedError();
            await this.settingRepository.set(RECORDING_SETTING, enabled ? 'on' : 'off');
            if (enabled && !this.recorder.enabled) await this.start();
            if (!enabled && this.recorder.enabled) await this.recorder.stop();
            this.logger.info(enabled ? `diagnostics recording turned on at ${effectiveRoot(this.config)}` : 'diagnostics recording turned off');
            return this.status();
        });
        this.transition = result.catch(() => undefined);
        return result;
    }
    private async start(): Promise<void> {
        await this.recorder.start(effectiveRoot(this.config));
        if (!this.recorder.enabled) {
            this.logger.error('diagnostics recording could not be started; check directory access and free space');
            throw new RecordingStartError();
        }
    }
    async restoreAtBoot(): Promise<void> {
        if (process.env.GATEWAY_DIAGNOSTICS_DIR) return;
        if (await this.settingRepository.get(RECORDING_SETTING) === 'on') {
            try { await this.start(); } catch (err) {
                // Recording failure must not prevent an unattended gateway receiving captures.
                if (!(err instanceof RecordingStartError)) throw err;
            }
        }
    }
    private dto(manifest: SegmentManifest): SegmentDto {
        const active = this.recorder.enabled && this.recorder.segmentId === manifest.segment_id;
        return { id: manifest.segment_id, status: active ? 'recording' : manifest.status, started_at: manifest.started_at, updated_at: manifest.updated_at, bytes: manifest.bytes, dropped_events: manifest.dropped_events, node: manifest.node, active };
    }
    private id(value: string, what: string): string {
        const id = diagnosticId(value);
        if (!id) throw new InvalidDiagnosticIdError(what);
        return id;
    }
    private async flushActive(id?: string): Promise<void> {
        if (this.recorder.enabled && (!id || this.recorder.segmentId === id)) await this.recorder.flush();
    }
    private async captures(runId: string): Promise<CaptureRefDto[]> {
        return (await this.captureRepository.findByDiagnosticRunId(runId)).map(({ id, status, sent_at }) => ({ id, status, sent_at }));
    }
    async overview(): Promise<{ recording: RecordingStatus; segments: SegmentDto[] }> {
        await this.flushActive();
        return { recording: this.status(), segments: (await this.store.list()).map(m => this.dto(m)) };
    }
    async segment(value: string): Promise<SegmentDetailDto> {
        const id = this.id(value, 'segment id');
        await this.flushActive(id);
        const store = this.store;
        const manifest = await store.manifest(id);
        if (!manifest) throw new SegmentNotFoundError(id);
        const { events, malformed } = await store.readEvents(id);
        const runs = await Promise.all(runsSeen(events).map(async run_id => {
            const delivery = pendingDeliveries(events.filter(e => e.run_id === run_id));
            return { run_id, acknowledged: delivery.acknowledged.length, pending: delivery.pending.length, captures: await this.captures(run_id) };
        }));
        return { segment: this.dto(manifest), spans: spanRows(events), events: eventCounts(events), runs, malformed_lines: malformed };
    }
    async run(value: string): Promise<RunDetailDto> {
        const run_id = this.id(value, 'run id');
        await this.flushActive();
        const store = this.store, events: SummaryEvent[] = [], segments: string[] = [];
        for (const manifest of await store.list()) {
            const read = await store.readEvents(manifest.segment_id, e => e.run_id === run_id);
            if (read.events.length) { segments.push(manifest.segment_id); for (const event of read.events) events.push(event); }
        }
        const captures = await this.captures(run_id);
        if (!segments.length && !captures.length) throw new RunNotFoundError(run_id);
        const delivery = pendingDeliveries(events);
        return { run_id, segments, spans: spanRows(events), events: eventCounts(events), acknowledged: delivery.acknowledged.length, pending: delivery.pending.length, captures };
    }
    async archive(value: string): Promise<{ id: string; stream: NodeJS.ReadableStream }> {
        const id = this.id(value, 'segment id');
        await this.flushActive(id);
        const store = this.store;
        if (!await store.manifest(id)) throw new SegmentNotFoundError(id);
        return { id, stream: await store.archive(id) };
    }

    private cleanStatus(status: PhoneStatusSnapshotDto | PhoneStatusSnapshot | null | undefined): PhoneStatusSnapshot | null {
        if (!status || typeof status !== 'object') return null;
        const out: PhoneStatusSnapshot = {};
        if (typeof status.battery_level === 'number' && Number.isFinite(status.battery_level)) out.battery_level = status.battery_level;
        else if (status.battery_level === null) out.battery_level = null;
        if (typeof status.charging === 'boolean' || status.charging === null) out.charging = status.charging;
        if (typeof status.battery_temperature_c === 'number' && Number.isFinite(status.battery_temperature_c)) out.battery_temperature_c = status.battery_temperature_c;
        else if (status.battery_temperature_c === null) out.battery_temperature_c = null;
        if (typeof status.power_save === 'boolean' || status.power_save === null) out.power_save = status.power_save;
        if (typeof status.thermal_status === 'number' && Number.isFinite(status.thermal_status)) out.thermal_status = status.thermal_status;
        else if (status.thermal_status === null) out.thermal_status = null;
        if (status.network_kind === 'wifi' || status.network_kind === 'cellular' || status.network_kind === 'none' || status.network_kind === 'other' || status.network_kind === null) out.network_kind = status.network_kind;
        if (typeof status.wifi_connected === 'boolean' || status.wifi_connected === null) out.wifi_connected = status.wifi_connected;
        if (typeof status.seeker_connected === 'boolean' || status.seeker_connected === null) out.seeker_connected = status.seeker_connected;
        if (typeof status.seeker_generation === 'number' && Number.isFinite(status.seeker_generation)) out.seeker_generation = status.seeker_generation;
        else if (status.seeker_generation === null) out.seeker_generation = null;
        if (typeof status.pending_uploads === 'number' && Number.isFinite(status.pending_uploads)) out.pending_uploads = status.pending_uploads;
        else if (status.pending_uploads === null) out.pending_uploads = null;
        if (typeof status.failed_uploads === 'number' && Number.isFinite(status.failed_uploads)) out.failed_uploads = status.failed_uploads;
        else if (status.failed_uploads === null) out.failed_uploads = null;
        if (typeof status.free_storage_bytes === 'number' && Number.isFinite(status.free_storage_bytes)) out.free_storage_bytes = status.free_storage_bytes;
        else if (status.free_storage_bytes === null) out.free_storage_bytes = null;
        return out;
    }

    private phoneDto(manifest: PhoneManifest): PhoneSummaryDto {
        return {
            device_id: manifest.device_id,
            manufacturer: manifest.manufacturer,
            device_model: manifest.device_model,
            android_version: manifest.android_version,
            api_level: manifest.api_level,
            app_version: manifest.app_version,
            model_revision: manifest.model_revision ?? null,
            first_seen_at: manifest.first_seen_at,
            last_seen_at: manifest.last_seen_at,
            status: manifest.status ?? null,
            counts: manifest.counts,
        };
    }

    async ingest(batch: PhoneBatchDto): Promise<PhoneIngestResultDto> {
        const device_id = this.id(batch.device_id, 'device id');
        const batch_id = this.id(batch.batch_id, 'batch id');
        const received_at = new Date().toISOString();
        const events: Record<string, unknown>[] = [];
        const resources: Record<string, unknown>[] = [];
        let seeker_disconnects = 0, wifi_disconnects = 0, captures_taken = 0, assessments_ready = 0, assessments_unavailable = 0;

        for (const item of batch.events) {
            const attributes = safePhoneAttributes(item.attributes);
            const record = {
                schema_version: 1,
                source: 'phone',
                device_id,
                batch_id,
                stream: item.stream,
                name: item.name,
                sequence: item.sequence,
                utc_ms: item.utc_ms,
                monotonic_ms: item.monotonic_ms,
                duration_ms: typeof item.duration_ms === 'number' && Number.isFinite(item.duration_ms) ? item.duration_ms : null,
                outcome: item.outcome,
                run_id: diagnosticId(item.run_id),
                operation_id: diagnosticId(item.operation_id),
                span_id: diagnosticId(item.span_id),
                attributes,
            };
            if (item.stream === 'resources') resources.push(record);
            else events.push(record);

            if (item.name === 'seeker.disconnected') seeker_disconnects++;
            if (item.name === 'network.change' && attributes.wifi_connected === false) wifi_disconnects++;
            if (item.name === 'capture.burst') {
                const shots = typeof attributes.shot_count === 'number' && attributes.shot_count > 0 ? Math.floor(attributes.shot_count) : 1;
                captures_taken += shots;
            }
            if (item.name === 'assessment.result') {
                if (attributes.assessment_status === 'ready') assessments_ready++;
                else if (attributes.assessment_status === 'unavailable') assessments_unavailable++;
            }
        }

        const crashes = batch.crashes.map(item => ({
            schema_version: 1,
            device_id,
            batch_id,
            crash_id: diagnosticId(item.crash_id) ?? item.crash_id.toLowerCase(),
            source: item.source,
            utc_ms: item.utc_ms,
            error_type: item.error_type,
            message: sanitizeCrashMessage(item.message),
            stack: sanitizeStack(item.stack),
            route: item.route ?? null,
            run_id: diagnosticId(item.run_id),
            operation_id: diagnosticId(item.operation_id),
            device_state: this.cleanStatus(item.device_state),
            app_version: batch.app_version,
            received_at,
        }));

        const status = this.cleanStatus(batch.status);
        const result = await this.phoneStore.append(
            device_id,
            batch_id,
            { events, resources, crashes },
            previous => {
                const prevCounts: PhoneCounts = previous?.counts ?? {
                    events: 0, crashes: 0, seeker_disconnects: 0, wifi_disconnects: 0, captures_taken: 0, assessments_ready: 0, assessments_unavailable: 0,
                };
                return {
                    schema_version: 1,
                    device_id,
                    manufacturer: batch.manufacturer,
                    device_model: batch.device_model,
                    android_version: batch.android_version,
                    api_level: batch.api_level,
                    app_version: batch.app_version,
                    model_revision: batch.model_revision ?? previous?.model_revision ?? null,
                    model_manifest_sha256: batch.model_manifest_sha256 ?? previous?.model_manifest_sha256 ?? null,
                    first_seen_at: previous?.first_seen_at ?? received_at,
                    last_seen_at: received_at,
                    status: status ?? previous?.status ?? null,
                    counts: {
                        events: prevCounts.events + batch.events.length,
                        crashes: prevCounts.crashes + crashes.length,
                        seeker_disconnects: prevCounts.seeker_disconnects + seeker_disconnects,
                        wifi_disconnects: prevCounts.wifi_disconnects + wifi_disconnects,
                        captures_taken: prevCounts.captures_taken + captures_taken,
                        assessments_ready: prevCounts.assessments_ready + assessments_ready,
                        assessments_unavailable: prevCounts.assessments_unavailable + assessments_unavailable,
                    },
                    recent_batch_ids: previous?.recent_batch_ids ?? [],
                };
            },
        );

        if (result.duplicate) return { accepted_events: 0, accepted_crashes: 0, duplicate_batch: true };
        return { accepted_events: batch.events.length, accepted_crashes: crashes.length, duplicate_batch: false };
    }

    async listPhones(): Promise<{ phones: PhoneSummaryDto[] }> {
        return { phones: (await this.phoneStore.list()).map(m => this.phoneDto(m)) };
    }

    async phoneDetail(value: string): Promise<PhoneDetailDto> {
        const id = this.id(value, 'device id');
        const store = this.phoneStore;
        const manifest = await store.manifest(id);
        if (!manifest) throw new PhoneNotFoundError(id);

        const [eventsRead, resourcesRead, crashesRead] = await Promise.all([
            store.read(id, 'events'),
            store.read(id, 'resources'),
            store.read(id, 'crashes'),
        ]);

        const toEventRow = (raw: Record<string, unknown>, fallbackStream: 'events' | 'resources'): PhoneEventRowDto => ({
            stream: raw.stream === 'resources' ? 'resources' : fallbackStream,
            name: typeof raw.name === 'string' ? raw.name : 'unknown',
            sequence: typeof raw.sequence === 'number' && Number.isFinite(raw.sequence) ? raw.sequence : 0,
            utc_ms: typeof raw.utc_ms === 'number' && Number.isFinite(raw.utc_ms) ? raw.utc_ms : 0,
            duration_ms: typeof raw.duration_ms === 'number' && Number.isFinite(raw.duration_ms) ? raw.duration_ms : null,
            outcome: typeof raw.outcome === 'string' ? raw.outcome : 'ok',
            run_id: diagnosticId(raw.run_id),
            operation_id: diagnosticId(raw.operation_id),
            span_id: diagnosticId(raw.span_id),
            attributes: safePhoneAttributes(raw.attributes as Record<string, unknown> | undefined),
        });

        const eventRows = eventsRead.records.map(r => toEventRow(r, 'events'));
        const summaryEvents: SummaryEvent[] = eventRows.map(e => ({
            source: 'phone',
            name: e.name,
            outcome: e.outcome,
            duration_ms: e.duration_ms,
            run_id: e.run_id,
            operation_id: e.operation_id,
            attributes: e.attributes,
        }));

        const connectivity = eventRows.filter(e => isConnectivityEvent(e)).slice(-50).reverse();
        const recent_events = eventRows.slice(-100).reverse();

        const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const resources: PhoneResourceRowDto[] = resourcesRead.records.slice(-30).reverse().map(raw => {
            const attrs = safePhoneAttributes(raw.attributes as Record<string, unknown> | undefined);
            return {
                name: typeof raw.name === 'string' ? raw.name : 'resource.sample',
                utc_ms: typeof raw.utc_ms === 'number' && Number.isFinite(raw.utc_ms) ? raw.utc_ms : 0,
                battery_level: numOrNull(attrs.battery_level),
                battery_temperature_c: numOrNull(attrs.battery_temperature_c),
                thermal_status: numOrNull(attrs.thermal_status),
                cpu_percent: numOrNull(attrs.cpu_percent),
                pss_bytes: numOrNull(attrs.pss_bytes),
                available_memory_bytes: numOrNull(attrs.available_memory_bytes),
            };
        });

        const crashes: PhoneCrashRowDto[] = crashesRead.records
            .map((raw): PhoneCrashRowDto => ({
                crash_id: diagnosticId(raw.crash_id) ?? (typeof raw.crash_id === 'string' ? raw.crash_id : ''),
                source: raw.source === 'native' ? 'native' : 'js',
                utc_ms: typeof raw.utc_ms === 'number' && Number.isFinite(raw.utc_ms) ? raw.utc_ms : 0,
                error_type: typeof raw.error_type === 'string' ? raw.error_type : 'Error',
                message: sanitizeCrashMessage(typeof raw.message === 'string' ? raw.message : ''),
                stack: sanitizeStack(Array.isArray(raw.stack) ? raw.stack.filter((s): s is string => typeof s === 'string') : []),
                route: typeof raw.route === 'string' ? raw.route : null,
                run_id: diagnosticId(raw.run_id),
                operation_id: diagnosticId(raw.operation_id),
                device_state: this.cleanStatus(raw.device_state as PhoneStatusSnapshot | null | undefined),
                app_version: typeof raw.app_version === 'string' ? raw.app_version : null,
                received_at: typeof raw.received_at === 'string' ? raw.received_at : null,
            }))
            .sort((a, b) => b.utc_ms - a.utc_ms)
            .slice(0, 50);

        return {
            phone: this.phoneDto(manifest),
            crashes,
            connectivity,
            captures_and_models: {
                spans: spanRows(summaryEvents),
                detector: detectorSummary(summaryEvents),
                assessments: assessmentSummary(summaryEvents),
            },
            recent_events,
            resources,
            malformed_lines: eventsRead.malformed + resourcesRead.malformed + crashesRead.malformed,
        };
    }

    async phoneArchive(value: string): Promise<{ id: string; stream: NodeJS.ReadableStream }> {
        const id = this.id(value, 'device id');
        const store = this.phoneStore;
        if (!await store.manifest(id)) throw new PhoneNotFoundError(id);
        return { id, stream: await store.archive(id) };
    }
}
