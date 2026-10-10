import { Inject, Service } from 'typedi';
import { DataSource, Repository } from 'typeorm';
import { DATABASE } from '../../../tokens';
import { SettingEntity } from '../entities';

@Service()
export class SettingRepository {
    private readonly repo: Repository<SettingEntity>;

    constructor(@Inject(DATABASE) database: DataSource) {
        this.repo = database.getRepository(SettingEntity);
    }

    async get(key: string): Promise<string | null> {
        const row = await this.repo.findOneBy({ key });
        return row?.value ?? null;
    }

    async set(key: string, value: string): Promise<void> {
        await this.repo.save(this.repo.create({ key, value, created_at: new Date().toISOString() }));
    }
}
