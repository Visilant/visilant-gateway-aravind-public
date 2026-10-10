import { Body, HttpCode, JsonController, Post, UnauthorizedError } from 'routing-controllers';
import { Service } from 'typedi';
import { AuthTokensDto, RefreshDto, SignInDto } from '../../application/dto';
import { AuthService, InvalidCredentialsError } from '../../application/services';

// Paths and payloads match what the Android app already calls, so its login screen and
// refresh interceptor work against the gateway without an app release.
@JsonController()
@Service()
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    @Post('/signin')
    @HttpCode(200)
    async signIn(@Body() body: SignInDto): Promise<AuthTokensDto> {
        try {
            return await this.authService.signIn(body.email, body.password);
        } catch (err) {
            if (err instanceof InvalidCredentialsError) throw new UnauthorizedError(err.message);
            throw err;
        }
    }

    @Post('/refresh')
    @HttpCode(200)
    async refresh(@Body() body: RefreshDto): Promise<AuthTokensDto> {
        try {
            return await this.authService.refresh(body.refresh_token);
        } catch (err) {
            if (err instanceof InvalidCredentialsError) throw new UnauthorizedError(err.message);
            throw err;
        }
    }
}
