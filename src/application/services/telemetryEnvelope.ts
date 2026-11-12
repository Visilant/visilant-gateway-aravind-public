import type { TelemetryEventEntity } from '../../infrastructure/database';

// A row as it leaves the gateway, to central or in an export: the envelope with the
// payload as an object. sent_at is outbox bookkeeping and never leaves.
export function toEnvelope(row: TelemetryEventEntity): Record<string, unknown> {
    const { sent_at: _sentAt, payload, ...rest } = row;
    return { ...rest, payload: JSON.parse(payload) as unknown };
}
