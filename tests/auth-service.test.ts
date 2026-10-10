import bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import type { GatewayConfig } from '../src/config';
import { AuthService, InvalidCredentialsError } from '../src/application/services/AuthService';
import { SecretService } from '../src/application/services/SecretService';
import { UserEntity } from '../src/infrastructure/database/entities';
import { SettingRepository, UserRepository } from '../src/infrastructure/database/repositories';
import { buildDataSourceOptions } from '../src/infrastructure/database/options';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const config = { centre_code: 'ARAVIND_XX' } as GatewayConfig;

let database: DataSource;
let users: UserRepository;
let settings: SettingRepository;
let auth: AuthService;
let secrets: SecretService;

async function seedUser(overrides: Partial<UserEntity> = {}): Promise<UserEntity> {
    return users.create({
        id: 'u1',
        email: 'nurse@aravind.org',
        username: 'nurse',
        password: await bcrypt.hash('correct-horse', 4),
        display_name: 'Nurse',
        role: 'OPERATOR',
        active: true,
        created_at: new Date().toISOString(),
        ...overrides,
    } as Partial<UserEntity>);
}

beforeEach(async () => {
    database = new DataSource(buildDataSourceOptions(':memory:'));
    await database.initialize();
    await database.runMigrations();

    users = new UserRepository(database);
    settings = new SettingRepository(database);
    secrets = new SecretService(logger as never, settings);
    auth = new AuthService(config, users, secrets);
});

afterEach(async () => { await database.destroy(); });

describe('signIn', () => {
    it('issues tokens and the user shape the app expects', async () => {
        await seedUser();
        const result = await auth.signIn('nurse@aravind.org', 'correct-horse');

        expect(result.token).toBeTruthy();
        expect(result.refresh_token).toBeTruthy();
        // The app's schema requires all four and rejects the response without them.
        expect(Object.keys(result.user).sort()).toEqual(['email', 'id', 'person_id', 'username']);
    });

    it('accepts an email in any case, with surrounding whitespace', async () => {
        await seedUser();
        await expect(auth.signIn('  NURSE@Aravind.ORG ', 'correct-horse')).resolves.toBeTruthy();
    });

    it.each([
        ['a wrong password', 'nurse@aravind.org', 'wrong'],
        ['an unknown account', 'nobody@aravind.org', 'anything'],
    ])('rejects %s', async (_label, email, password) => {
        await seedUser();
        await expect(auth.signIn(email, password)).rejects.toThrow(InvalidCredentialsError);
    });

    // Distinguishing the two would let someone enumerate which accounts exist.
    it('gives the same message for a wrong password and an unknown account', async () => {
        await seedUser();
        const wrongPassword = await auth.signIn('nurse@aravind.org', 'wrong').catch((e: Error) => e.message);
        const noSuchUser = await auth.signIn('nobody@aravind.org', 'wrong').catch((e: Error) => e.message);
        expect(wrongPassword).toBe(noSuchUser);
    });

    it('rejects a deactivated account even with the right password', async () => {
        await seedUser({ active: false });
        await expect(auth.signIn('nurse@aravind.org', 'correct-horse')).rejects.toThrow(InvalidCredentialsError);
    });

    it('never returns the password hash', async () => {
        await seedUser();
        const result = await auth.signIn('nurse@aravind.org', 'correct-horse');
        expect(JSON.stringify(result)).not.toMatch(/\$2[aby]\$/);
    });
});

describe('refresh', () => {
    it('exchanges a refresh token for a new pair', async () => {
        await seedUser();
        const first = await auth.signIn('nurse@aravind.org', 'correct-horse');
        const next = await auth.refresh(first.refresh_token);
        expect(next.token).toBeTruthy();
        expect(next.user.id).toBe('u1');
    });

    // Re-reading the user is the point: a token issued before deactivation must not
    // let someone refresh their way back in indefinitely.
    it('refuses once the account is deactivated', async () => {
        await seedUser();
        const { refresh_token } = await auth.signIn('nurse@aravind.org', 'correct-horse');

        await database.getRepository(UserEntity).update('u1', { active: false });

        await expect(auth.refresh(refresh_token)).rejects.toThrow(InvalidCredentialsError);
    });

    it('refuses a garbage token', async () => {
        await expect(auth.refresh('not.a.token')).rejects.toThrow(InvalidCredentialsError);
    });

    // Access and refresh are signed with different secrets, so one must not stand in
    // for the other.
    it('refuses an access token used as a refresh token', async () => {
        await seedUser();
        const { token } = await auth.signIn('nurse@aravind.org', 'correct-horse');
        await expect(auth.refresh(token)).rejects.toThrow(InvalidCredentialsError);
    });
});

describe('authenticate', () => {
    it('resolves the user from a valid bearer token', async () => {
        await seedUser();
        const { token } = await auth.signIn('nurse@aravind.org', 'correct-horse');

        expect((await auth.authenticate(`Bearer ${token}`))?.id).toBe('u1');
        expect((await auth.authenticate(token))?.id).toBe('u1');   // bare token too
    });

    it.each([
        ['no header', undefined],
        ['garbage', 'Bearer nonsense'],
        ['empty', ''],
    ])('returns null for %s', async (_label, header) => {
        expect(await auth.authenticate(header as string | undefined)).toBeNull();
    });

    it('returns null once the account is deactivated', async () => {
        await seedUser();
        const { token } = await auth.signIn('nurse@aravind.org', 'correct-horse');
        await database.getRepository(UserEntity).update('u1', { active: false });

        expect(await auth.authenticate(`Bearer ${token}`)).toBeNull();
    });
});

describe('SecretService', () => {
    it('generates a secret pair on first use and reuses it afterwards', async () => {
        const first = await secrets.getSigningSecrets();
        const fresh = new SecretService(logger as never, settings);   // as if restarted
        const second = await fresh.getSigningSecrets();

        expect(second).toEqual(first);
    });

    it('uses different secrets for access and refresh', async () => {
        const { access, refresh } = await secrets.getSigningSecrets();
        expect(access).not.toBe(refresh);
        expect(access.length).toBeGreaterThanOrEqual(43);
    });

    // A secret regenerated on every boot would sign every operator out whenever the
    // clinic machine restarts.
    it('survives a restart so issued tokens stay valid', async () => {
        await seedUser();
        const { token } = await auth.signIn('nurse@aravind.org', 'correct-horse');

        const restarted = new AuthService(config, users, new SecretService(logger as never, settings));
        expect((await restarted.authenticate(`Bearer ${token}`))?.id).toBe('u1');
    });

    it('never writes a secret value to the log', async () => {
        const { access } = await secrets.getSigningSecrets();
        const logged = logger.info.mock.calls.map((c) => String(c[0])).join(' ');
        expect(logged).not.toContain(access);
    });
});
