import { IsNotEmpty, IsString } from 'class-validator';

export class SignInDto {
    @IsString()
    @IsNotEmpty()
    email!: string;

    @IsString()
    @IsNotEmpty()
    password!: string;
}

export class RefreshDto {
    @IsString()
    @IsNotEmpty()
    refresh_token!: string;
}

// Mirrors what the Android app already parses, so its login screen and token refresh
// work against the gateway unchanged.
export class AuthUserDto {
    id!: string;
    username!: string;
    email!: string;
    // The app's schema requires this and the gateway has no Person table — it carries
    // no meaning here, and the app only stores it. Kept so the existing screen
    // validates rather than forcing an app release.
    person_id!: string;
}

export class AuthTokensDto {
    token!: string;
    refresh_token!: string;
    user!: AuthUserDto;
}
