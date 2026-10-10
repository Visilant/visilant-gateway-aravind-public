import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum UserRole {
    OPERATOR = 'OPERATOR',
    ADMIN = 'ADMIN',
}

// Local operators. Deliberately flat — no roles, permissions, or person tables. The
// gateway has one screen flow, and users are seeded at install rather than synced.
@Entity('user')
export class UserEntity {
    @PrimaryColumn({ type: 'text' })
    id!: string;

    @Column({ type: 'text', unique: true })
    username!: string;

    @Column({ type: 'text', nullable: true })
    email!: string | null;

    @Column({ type: 'text' })
    password!: string; // bcrypt

    @Column({ type: 'text', nullable: true })
    display_name!: string | null;

    @Column({ type: 'text', default: UserRole.OPERATOR })
    role!: UserRole;

    @Column({ type: 'boolean', default: true })
    active!: boolean;

    @Column({ type: 'text' })
    created_at!: string; // ISO8601
}
