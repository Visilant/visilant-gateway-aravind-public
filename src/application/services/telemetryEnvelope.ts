import type { TelemetryEventEntity } from '../../infrastructure/database';

// A row as it leaves the gateway, to central or in an export: the envelope with the
// payload as an object. The outbox bookkeeping (seq, sent_at, push attempts and
// quarantine) never leaves.
export function toEnvelope(row: TelemetryEventEntity): Record<string, unknown> {
    const {
        seq: _seq, sent_at: _sentAt, push_attempts: _attempts, quarantined_at: _quarantinedAt, quarantine_reason: _reason,
        payload, ...rest
    } = row;
    return { ...rest, payload: JSON.parse(payload) as unknown };
}
