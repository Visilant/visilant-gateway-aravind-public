import { Inject, Service } from 'typedi';
import { DataSource } from 'typeorm';
import { CaptureEntity, CaptureStatus, SettingEntity } from '../entities';
import { DATABASE } from '../../../tokens';

export interface SetupVerification {
    started_at: string;
    phone_signin_at?: string;
    worklist_at?: string;
    completed_at?: string;
}
const KEY = 'setup.verification';

@Service()
export class SetupRepository {
    constructor(@Inject(DATABASE) private readonly database: DataSource) {}

    async read(): Promise<SetupVerification | null> {
        const row = await this.database.getRepository(SettingEntity).findOneBy({ key: KEY });
        return row ? JSON.parse(row.value) as SetupVerification : null;
    }

    async save(value: SetupVerification): Promise<void> {
        await this.database.getRepository(SettingEntity).upsert({
            key: KEY, value: JSON.stringify(value), created_at: value.started_at,
        }, ['key']);
    }

    async captureCounts(startedAt?: string) {
        const counts = startedAt ? await this.database.getRepository(CaptureEntity).createQueryBuilder('capture')
            .select('capture.status', 'status').addSelect('COUNT(*)', 'count')
            .where('capture.created_at >= :started', { started: startedAt })
            .groupBy('capture.status').getRawMany<{ status: string; count: number }>() : [];
        const count = (status: CaptureStatus) => Number(counts.find(row => row.status === status)?.count ?? 0);
        return { received: counts.reduce((sum, row) => sum + Number(row.count), 0),
            sent: count(CaptureStatus.SENT), waiting: count(CaptureStatus.PENDING) + count(CaptureStatus.SENDING),
            failed: count(CaptureStatus.FAILED) };
    }
}
