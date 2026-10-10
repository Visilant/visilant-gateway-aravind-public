import { Inject, Service } from 'typedi';
import { DataSource, Repository } from 'typeorm';
import { DATABASE } from '../../../tokens';
import { UserEntity } from '../entities';

@Service()
export class UserRepository {
    private readonly repo: Repository<UserEntity>;

    constructor(@Inject(DATABASE) database: DataSource) {
        this.repo = database.getRepository(UserEntity);
    }

    findById(id: string): Promise<UserEntity | null> {
        return this.repo.findOneBy({ id });
    }

    // Operators sign in with an email address, which is what the app's login screen
    // collects. Usernames exist for the seeding CLI and for display.
    findByEmail(email: string): Promise<UserEntity | null> {
        return this.repo.findOneBy({ email: email.trim().toLowerCase() });
    }

    findByUsername(username: string): Promise<UserEntity | null> {
        return this.repo.findOneBy({ username: username.trim().toLowerCase() });
    }

    create(data: Partial<UserEntity>): Promise<UserEntity> {
        return this.repo.save(this.repo.create(data));
    }

    updatePassword(id: string, password: string): Promise<unknown> {
        return this.repo.update(id, { password });
    }

    count(): Promise<number> {
        return this.repo.count();
    }
}
