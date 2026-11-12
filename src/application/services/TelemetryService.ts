import { Inject, Service } from 'typedi';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import type { GatewayConfig } from '../../config';
import { TelemetryEventEntity } from '../../infrastructure/database';
import { SettingRepository, TelemetryRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER } from '../../tokens';
import { PUSH_BATCH_SIZE, TelemetryPushWorker } from './TelemetryPushWorker';
import type { GatewayEventType, TelemetryEventDto, TelemetryIngestResultDto } from '../dto';

const GATEWAY_ID_KEY = 'telemetry.gateway_id';

// Writes telemetry into the SQLite outbox: phone events from POST /telemetry/events and
// the gateway's own events. Pushing and pruning are TelemetryPushWorker and
// TelemetryOutbox. See docs/telemetry.md.
@Service()
export class TelemetryService {
    private gatewayIdValue: string | null = null;

    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly repository: TelemetryRepository,
        private readonly settings: SettingRepository,
        private readonly push: TelemetryPushWorker,
    ) {}

    get enabled(): boolean {
        return this.config.telemetry.enabled;
    }

    // Generated on first use and kept in the Setting table, so it survives a reinstall
    // that keeps the database. It tells apart two gateways at one site.
    async gatewayId(): Promise<string> {
        if (this.gatewayIdValue) return this.gatewayIdValue;
        let value = await this.settings.get(GATEWAY_ID_KEY);
        if (!value) {
            value = uuidv4();
            await this.settings.set(GATEWAY_ID_KEY, value);
            this.logger.info(`telemetry: generated gateway_id ${value}`);
        }
        this.gatewayIdValue = value;
        return value;
    }

    async ingest(events: TelemetryEventDto[]): Promise<TelemetryIngestResultDto> {
        const gatewayId = await this.gatewayId();
        const receivedAt = new Date().toISOString();
        const rows = events.map((event) => Object.assign(new TelemetryEventEntity(), {
            event_id: event.event_id,
            schema_version: event.schema_version,
            type: event.type,
            occurred_at: event.occurred_at,
            received_at: receivedAt,
            site_id: this.siteId(),
            gateway_id: gatewayId,
            device_id: event.device_id,
            session_id: event.session_id,
            capture_id: event.capture_id ?? null,
            screening_id: event.screening_id ?? null,
            payload: JSON.stringify(event.payload),
            sent_at: null,
        }));

        const inserted = await this.repository.insertOrIgnore(rows);
        const result: TelemetryIngestResultDto = { accepted: [], duplicate: [], dropped: [] };
        rows.forEach((row, i) => (inserted[i] ? result.accepted : result.duplicate).push(row.event_id));

        // A full batch is waiting: send now instead of at the next minute. Not awaited,
        // so the phone's answer never waits on the internet.
        if (result.accepted.length > 0 && await this.repository.countUnsent() >= PUSH_BATCH_SIZE) {
            void this.push.kick().catch(() => undefined);
        }
        return result;
    }

    // One of the gateway's own events. Does nothing when telemetry is off. Returns the
    // event_id written, or null.
    async record(
        type: GatewayEventType,
        payload: Record<string, unknown>,
        ids: { capture_id?: string | null; screening_id?: string | null } = {},
    ): Promise<string | null> {
        if (!this.enabled) return null;
        const now = new Date().toISOString();
        const row = Object.assign(new TelemetryEventEntity(), {
            event_id: uuidv7(),
            schema_version: 1,
            type,
            occurred_at: now,
            received_at: now,
            site_id: this.siteId(),
            gateway_id: await this.gatewayId(),
            device_id: null,
            session_id: null,
            capture_id: ids.capture_id ?? null,
            screening_id: ids.screening_id ?? null,
            payload: JSON.stringify(payload),
            sent_at: null,
        });
        await this.repository.insertOrIgnore([row]);
        return row.event_id;
    }

    private siteId(): string {
        // Validated at start-up: enabled implies a site_id.
        return this.config.telemetry.site_id as string;
    }
}
