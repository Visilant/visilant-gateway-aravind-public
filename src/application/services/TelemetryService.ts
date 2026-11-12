import { Inject, Service } from 'typedi';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import type { GatewayConfig } from '../../config';
import { TelemetryEventEntity } from '../../infrastructure/database';
import { SettingRepository, TelemetryRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { CONFIG, LOGGER } from '../../tokens';
import { TelemetryOutbox } from './TelemetryOutbox';
import { toEnvelope } from './telemetryEnvelope';
import { PUSH_BATCH_SIZE, TelemetryPushWorker } from './TelemetryPushWorker';
import { PRE_SIGN_IN_EVENT_TYPES, type GatewayEventType, type TelemetryEventDto, type TelemetryIngestResultDto } from '../dto';

const GATEWAY_ID_KEY = 'telemetry.gateway_id';

// GET /telemetry/export?since= names an event this outbox does not hold.
export class TelemetryCursorNotFoundError extends Error {
    constructor() {
        super('since is not an event in this outbox (it may have been sent and pruned); omit since for a full export');
    }
}

// A batch without a valid token carried a type that needs a signed-in phone.
export class TelemetrySignInRequiredError extends Error {
    constructor(readonly eventType: string) {
        super(`${eventType} needs a signed-in phone; sign in, then send it again`);
    }
}
const EXPORT_PAGE = 500;

// Writes telemetry into the SQLite outbox: phone events from POST /telemetry/events and
// the gateway's own events. Pushing and pruning are TelemetryPushWorker and
// TelemetryOutbox. See docs/telemetry.md.
@Service()
export class TelemetryService {
    private gatewayIdValue: Promise<string> | null = null;

    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly repository: TelemetryRepository,
        private readonly settings: SettingRepository,
        private readonly push: TelemetryPushWorker,
        private readonly outbox: TelemetryOutbox,
    ) {}

    get enabled(): boolean {
        return this.config.telemetry.enabled;
    }

    // Generated on first use and kept in the Setting table, so it survives a reinstall
    // that keeps the database. It tells apart two gateways at one site.
    // INSERT OR IGNORE then read, so concurrent first calls (and two processes) agree.
    gatewayId(): Promise<string> {
        this.gatewayIdValue ??= this.loadGatewayId().catch((err: unknown) => {
            this.gatewayIdValue = null;
            throw err;
        });
        return this.gatewayIdValue;
    }

    private async loadGatewayId(): Promise<string> {
        const existing = await this.settings.get(GATEWAY_ID_KEY);
        if (existing) return existing;
        const candidate = uuidv4();
        const stored = await this.settings.insertIfAbsent(GATEWAY_ID_KEY, candidate);
        if (stored === candidate) this.logger.info(`telemetry: generated gateway_id ${stored}`);
        return stored;
    }

    // `authenticated`: whether the request carried a valid token. Without one, only the
    // pre-sign-in types are taken, and the whole batch is refused otherwise.
    async ingest(events: TelemetryEventDto[], authenticated: boolean): Promise<TelemetryIngestResultDto> {
        if (!authenticated) {
            const needsSignIn = events.find((event) => !PRE_SIGN_IN_EVENT_TYPES.includes(event.type));
            if (needsSignIn) throw new TelemetrySignInRequiredError(needsSignIn.type);
        }
        const gatewayId = await this.gatewayId();
        const receivedAt = new Date().toISOString();
        const result: TelemetryIngestResultDto = { accepted: [], duplicate: [], dropped: [] };
        // The outbox is full of rows central has not confirmed: shed device.health only.
        const kept = this.outbox.acceptsDeviceHealth() ? events : events.filter((event) => {
            if (event.type !== 'device.health') return true;
            result.dropped.push(event.event_id);
            return false;
        });
        const rows = kept.map((event) => Object.assign(new TelemetryEventEntity(), {
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
            authenticated,
            payload: JSON.stringify(event.payload),
            sent_at: null,
        }));

        const inserted = await this.repository.insertOrIgnore(rows);
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
            authenticated: null,
            payload: JSON.stringify(payload),
            sent_at: null,
        });
        await this.repository.insertOrIgnore([row]);
        return row.event_id;
    }

    // Unsent rows after `since`, one NDJSON line each, read a page at a time so a long
    // backlog is never held in memory. For a site whose internet is down for long: a
    // support person uploads the file to central, which ignores what it already has.
    // `since` is an event_id; the rows returned are the ones written after it, whatever
    // their clocks say.
    // The cursor is resolved before anything is streamed, so a bad one is a 400.
    async exportUnsent(since: string | null): Promise<AsyncGenerator<string>> {
        let cursor = 0;
        if (since) {
            const seq = await this.repository.seqOf(since);
            if (seq === null) throw new TelemetryCursorNotFoundError();
            cursor = seq;
        }
        return this.pages(cursor);
    }

    private async *pages(after: number): AsyncGenerator<string> {
        let cursor = after;
        for (;;) {
            const page = await this.repository.findUnsent(EXPORT_PAGE, cursor);
            if (page.length === 0) return;
            yield page.map((row) => JSON.stringify(toEnvelope(row)) + '\n').join('');
            if (page.length < EXPORT_PAGE) return;
            cursor = page[page.length - 1].seq;
        }
    }

    exportFilename(now = new Date()): string {
        const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        return `telemetry-${this.config.telemetry.site_id ?? 'no-site'}-${stamp}.ndjson`;
    }

    private siteId(): string {
        // Validated at start-up: enabled implies a site_id.
        return this.config.telemetry.site_id as string;
    }
}
