import { randomBytes } from 'crypto';
import { Inject, Service } from 'typedi';
import { SettingRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { LOGGER } from '../../tokens';

const ACCESS_SECRET_KEY = 'jwt.access_secret';
const REFRESH_SECRET_KEY = 'jwt.refresh_secret';

export interface SigningSecrets {
    access: string;
    refresh: string;
}

// The JWT signing secrets, generated on this machine the first time it runs.
//
// They are deliberately NOT in config.json and not in the installer: a secret shipped
// with the package would be identical at every centre, so a token minted on one
// gateway would authenticate against all of them.
@Service()
export class SecretService {
    private cached: SigningSecrets | null = null;

    constructor(
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly settingRepository: SettingRepository,
    ) {}

    async getSigningSecrets(): Promise<SigningSecrets> {
        if (this.cached) return this.cached;

        const access = await this.getOrCreate(ACCESS_SECRET_KEY);
        const refresh = await this.getOrCreate(REFRESH_SECRET_KEY);

        this.cached = { access, refresh };
        return this.cached;
    }

    private async getOrCreate(key: string): Promise<string> {
        const existing = await this.settingRepository.get(key);
        if (existing) return existing;

        const secret = randomBytes(48).toString('base64url');
        await this.settingRepository.set(key, secret);
        // Says that a secret was created, never what it is.
        this.logger.info(`generated a new signing secret (${key}) for this gateway`);
        return secret;
    }
}
