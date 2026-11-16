import { Inject, Service } from 'typedi';
import { DataSource, Repository } from 'typeorm';
import { DATABASE } from '../../../tokens';
import { SettingEntity } from '../entities';

@Service()
export class SettingRepository {
    private readonly repo: Repository<SettingEntity>;

    constructor(@Inject(DATABASE) private readonly database: DataSource) {
        this.repo = database.getRepository(SettingEntity);
    }

    async get(key: string): Promise<string | null> {
        const row = await this.repo.findOneBy({ key });
        return row?.value ?? null;
    }

    // Atomic and transaction-free: concurrent first writers all end with the same row.
    // Returns the stored value, which is `value` only for the caller that won.
    async insertIfAbsent(key: string, value: string): Promise<string> {
        await this.database.query('INSERT OR IGNORE INTO "setting" ("key", "value", "created_at") VALUES (?, ?, ?)', [key, value, new Date().toISOString()]);
        return (await this.get(key)) as string;
    }

    async set(key: string, value: string): Promise<void> {
        await this.repo.save(this.repo.create({ key, value, created_at: new Date().toISOString() }));
    }
}
