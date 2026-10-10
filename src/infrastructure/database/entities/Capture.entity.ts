import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { ScreeningEntity } from './Screening.entity';
import { UserEntity } from './User.entity';

export enum CaptureStatus {
    PENDING = 'PENDING',
    SENDING = 'SENDING',
    SENT = 'SENT',
    FAILED = 'FAILED',
}

// Everything captured on this box, and whether it reached the archive.
//
// The row carries NO demographics. The DICOM object is built at capture time, so
// patient identity lives inside the .dcm file on disk and never enters the database.
// That also makes a retry a plain re-send of a finished file — no rebuild, and no
// dependency on the worklist entry still existing, which matters because RIS worklist
// entries disappear once a procedure is marked performed.
//
// Doubles as the audit trail: SENT rows are kept indefinitely, only the file is removed.
@Entity('capture')
@Index('idx_capture_due', ['status', 'next_attempt_at'])
@Index('idx_capture_screening', ['screening_id'])
export class CaptureEntity {
    @Column({ type: 'text', nullable: true })
    screening_id!: string | null;

    @ManyToOne(() => ScreeningEntity, { nullable: true, onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'screening_id' })
    screening?: ScreeningEntity | null;

    @Column({ type: 'text', nullable: true })
    diagnostic_run_id!: string | null;

    @Column({ type: 'text', nullable: true })
    diagnostic_operation_id!: string | null;

    @Column({ type: 'text', nullable: true })
    enqueued_at!: string | null;

    @PrimaryColumn({ type: 'text' })
    id!: string;

    @Index('idx_capture_client_id', { unique: true })
    @Column({ type: 'text', nullable: true })
    client_capture_id!: string | null;

    // Relative key under config.storage_root — never an absolute path, so the storage
    // root can move between installs.
    @Column({ type: 'text' })
    dicom_path!: string;

    @Column({ type: 'text' })
    status!: CaptureStatus;

    // From the worklist. Minting our own would land images in a different study from
    // the ordered one, which defeats worklist integration entirely.
    @Column({ type: 'text' })
    study_instance_uid!: string;

    // Ours to mint, derived deterministically so retries stay idempotent.
    @Column({ type: 'text' })
    series_instance_uid!: string;

    @Column({ type: 'text', unique: true })
    sop_instance_uid!: string;

    @Column({ type: 'text' })
    accession_number!: string;

    // Retry bookkeeping. Without it a permanently-malformed capture spins hot forever
    // and starves valid work behind it, on a box with nobody watching.
    @Column({ type: 'integer', default: 0 })
    attempts!: number;

    @Column({ type: 'text', nullable: true })
    next_attempt_at!: string | null; // ISO8601

    @Column({ type: 'text', nullable: true })
    last_error!: string | null;

    @Column({ type: 'text', nullable: true })
    created_by!: string | null;

    @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'created_by' })
    creator?: UserEntity | null;

    @Column({ type: 'text' })
    created_at!: string; // ISO8601

    @Column({ type: 'text', nullable: true })
    sent_at!: string | null; // ISO8601
}
