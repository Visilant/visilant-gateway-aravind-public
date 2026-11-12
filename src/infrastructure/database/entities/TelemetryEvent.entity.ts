import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// The telemetry outbox. One row per event, in the envelope that is also sent to central
// and stored there, so data from every site combines by a plain union on event_id.
// See docs/telemetry.md.
//
// No patient identity: payloads are validated against an allow-list per type, and
// capture_id / screening_id are opaque ids that join to a .dcm only on this computer.
//
// A row is deleted only after central has confirmed it (sent_at set).
@Entity('telemetry_event')
@Index('idx_telemetry_push', ['sent_at', 'quarantined_at', 'seq'])
@Index('idx_telemetry_occurred', ['occurred_at'])
export class TelemetryEventEntity {
    // Outbox only, never sent: the order rows were written. Clocks on phones and on this
    // computer can be wrong, so the push, the export cursor and unclean-shutdown
    // detection follow this, never a time. AUTOINCREMENT: never reused after a delete.
    @PrimaryGeneratedColumn('increment', { type: 'integer' })
    seq!: number;

    // UUIDv7, set by the producer. The global key: the gateway and central ignore an
    // event_id they already hold.
    @Index('idx_telemetry_event_id', { unique: true })
    @Column({ type: 'text' })
    event_id!: string;

    @Column({ type: 'integer' })
    schema_version!: number;

    @Column({ type: 'text' })
    type!: string;

    // ISO 8601 UTC, producer clock.
    @Column({ type: 'text' })
    occurred_at!: string;

    // ISO 8601 UTC, gateway clock. Central corrects phone clock skew with it.
    @Column({ type: 'text' })
    received_at!: string;

    @Column({ type: 'text' })
    site_id!: string;

    @Column({ type: 'text' })
    gateway_id!: string;

    // Null for the gateway's own events.
    @Column({ type: 'text', nullable: true })
    device_id!: string | null;

    @Column({ type: 'text', nullable: true })
    session_id!: string | null;

    @Column({ type: 'text', nullable: true })
    capture_id!: string | null;

    @Column({ type: 'text', nullable: true })
    screening_id!: string | null;

    // Whether the phone's request was signed in. A phone may send a few types before
    // sign-in, so central can tell those rows apart. Null for the gateway's own events.
    @Column({ type: 'boolean', nullable: true })
    authenticated!: boolean | null;

    // The type-specific fields as JSON text.
    @Column({ type: 'text' })
    payload!: string;

    // Outbox only, never sent: set when central confirms the event_id.
    @Column({ type: 'text', nullable: true })
    sent_at!: string | null;

    // Outbox only: times central answered for this row without confirming it.
    @Column({ type: 'integer', default: 0 })
    push_attempts!: number;

    // Outbox only: set when the push gives up on this row (central refused it alone, or
    // never confirmed it). It is no longer pushed, but kept and exported.
    @Column({ type: 'text', nullable: true })
    quarantined_at!: string | null;

    @Column({ type: 'text', nullable: true })
    quarantine_reason!: string | null;
}
