import { profile } from '../../infrastructure/diagnostics';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import type { UserEntity } from '../../infrastructure/database';
import { UserRepository } from '../../infrastructure/database/repositories';
import { CONFIG } from '../../tokens';
import { AuthTokensDto, AuthUserDto } from '../dto';
import { SecretService } from './SecretService';

const ACCESS_TTL = '4h';
const REFRESH_TTL = '15d';

export interface TokenPayload {
    id: string;
    username: string;
    email: string;
    tenant_id: string;
}

export class InvalidCredentialsError extends Error {
    constructor() {
        // One message for both a wrong address and a wrong password: saying which is
        // wrong tells an attacker which accounts exist.
        super('invalid email or password');
    }
}

@Service()
export class AuthService {
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        private readonly userRepository: UserRepository,
        private readonly secretService: SecretService,
    ) {}

    @profile('auth.signIn')
    async signIn(email: string, password: string): Promise<AuthTokensDto> {
        const user = await this.userRepository.findByEmail(email);

        // Compare against a dummy hash when the user does not exist, so a missing
        // account and a wrong password take the same time to answer.
        const hash = user?.password ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
        const matches = await bcrypt.compare(password, hash);

        if (!user || !matches || !user.active) throw new InvalidCredentialsError();

        return this.issue(user);
    }

    @profile('auth.refresh')
    async refresh(refreshToken: string): Promise<AuthTokensDto> {
        const secrets = await this.secretService.getSigningSecrets();

        let payload: TokenPayload;
        try {
            payload = jwt.verify(clean(refreshToken), secrets.refresh) as TokenPayload;
        } catch {
            throw new InvalidCredentialsError();
        }

        // Re-read the user rather than trusting the token: an account deactivated since
        // the token was issued must not be able to refresh its way back in.
        const user = await this.userRepository.findById(payload.id);
        if (!user || !user.active) throw new InvalidCredentialsError();

        return this.issue(user);
    }

    // Verifies an access token and returns the user it belongs to, or null.
    @profile('auth.authenticate')
    async authenticate(authorizationHeader: string | undefined): Promise<UserEntity | null> {
        if (!authorizationHeader) return null;

        const secrets = await this.secretService.getSigningSecrets();
        let payload: TokenPayload;
        try {
            payload = jwt.verify(clean(authorizationHeader), secrets.access) as TokenPayload;
        } catch {
            return null;
        }

        const user = await this.userRepository.findById(payload.id);
        return user && user.active ? user : null;
    }

    private async issue(user: UserEntity): Promise<AuthTokensDto> {
        const secrets = await this.secretService.getSigningSecrets();
        const payload: TokenPayload = {
            id: user.id,
            username: user.username,
            email: user.email ?? '',
            // The app sends x-tenant-id on every request; pinning the centre code here
            // keeps that contract intact without the app changing.
            tenant_id: this.config.centre_code,
        };

        return {
            token: jwt.sign(payload, secrets.access, { expiresIn: ACCESS_TTL }),
            refresh_token: jwt.sign(payload, secrets.refresh, { expiresIn: REFRESH_TTL }),
            user: toAuthUser(user),
        };
    }
}

function toAuthUser(user: UserEntity): AuthUserDto {
    return {
        id: user.id,
        username: user.username,
        email: user.email ?? '',
        person_id: user.id,
    };
}

function clean(token: string): string {
    return token.replace(/^Bearer\s+/i, '').trim();
}
