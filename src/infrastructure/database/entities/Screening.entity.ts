import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

// Why a stuck screening was released. A fixed list, never free text: on this box a typed
// reason would be the first place an operator writes a patient's name.
export const RELEASE_REASONS = ['PHONE_LOST', 'CAPTURE_REJECTED', 'RESHOOT', 'OTHER', 'EXPIRED'] as const;
export type ReleaseReason = typeof RELEASE_REASONS[number];
// EXPIRED is the inactivity backstop's own reason; an operator picks one of the others.
export const OPERATOR_RELEASE_REASONS = RELEASE_REASONS.filter(reason => reason !== 'EXPIRED');

// Immutable membership; no demographics or image payloads. Completion has no expiry.
// A screening that cannot finish is released instead: the row stays for audit, and the
// order key is freed so the order can be screened again.
// One live screening per order. Released rows keep their key but no longer hold it.
@Index('idx_screening_order', ['order_key'], { unique: true, where: '"released_at" IS NULL' })
@Entity('screening')
export class ScreeningEntity {
    @PrimaryColumn({ type: 'text' }) id!: string;
    @Column({ type: 'text' }) source_scope!: string;
    @Column({ type: 'text' }) order_key!: string;
    @Column({ type: 'text' }) accession_number!: string;
    @Column({ type: 'text' }) study_instance_uid!: string;
    @Column({ type: 'text', nullable: true }) step_id!: string | null;
    @Column({ type: 'text' }) capture_ids!: string;
    @Column({ type: 'text' }) created_at!: string;
    @Column({ type: 'text', nullable: true }) completed_at!: string | null;
    // Registration, a capture arriving, or an operator retry. Expiry measures idleness from here.
    @Column({ type: 'text' }) last_activity_at!: string;
    @Column({ type: 'text', nullable: true }) released_at!: string | null;
    // A user ID, or 'system:expiry'.
    @Column({ type: 'text', nullable: true }) released_by!: string | null;
    @Column({ type: 'text', nullable: true }) release_reason!: ReleaseReason | null;
}
