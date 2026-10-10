import path from 'path';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { CaptureRepository, SettingRepository } from '../../infrastructure/database/repositories';
import { DiagnosticRecorder, diagnosticId } from '../../infrastructure/diagnostics';
import { DiagnosticsStore, SegmentManifest } from '../../infrastructure/diagnostics/store';
import { eventCounts, pendingDeliveries, runsSeen, spanRows, SummaryEvent } from '../../infrastructure/diagnostics/summary';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER, RECORDER } from '../../tokens';
import type { CaptureRefDto, RecordingStatus, RunDetailDto, SegmentDetailDto, SegmentDto } from '../dto/diagnostics.dto';

export const RECORDING_SETTING = 'diagnostics.recording';
export class RecordingLockedError extends Error { constructor() { super('recording is controlled by GATEWAY_DIAGNOSTICS_DIR on this process'); } }
export class RecordingStartError extends Error { constructor() { super('recording could not be started; see the gateway log'); } }
export class InvalidDiagnosticIdError extends Error { constructor(what: string) { super(`${what} must be a UUID`); } }
export class SegmentNotFoundError extends Error { constructor(id: string) { super(`segment ${id} not found`); } }
export class RunNotFoundError extends Error { constructor(id: string) { super(`run ${id} not found`); } }
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
}
