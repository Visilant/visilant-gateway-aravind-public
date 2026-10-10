import { Body, BadRequestError, Get, HttpCode, JsonController, Post, UnauthorizedError, UseBefore } from 'routing-controllers';
import { Service } from 'typedi';
import type { NextFunction, Request, Response } from 'express';
import { SetupCompleteDto } from '../../application/dto';
import { SetupIncompleteError, SetupMissingItem, SetupVerificationService } from '../../application/services/SetupVerificationService';
import { isLoopback } from '../../setup/security';

// Private bridge used by the local launcher, never by the APK or dashboard. Only the
// launcher knows the per-launch token, and only loopback clients may present it.
export function requireSetupBridge(req: Request, _res: Response, next: NextFunction): void {
    const token = process.env.GATEWAY_SETUP_TOKEN;
    if (!token || !isLoopback(req.socket.remoteAddress) || req.headers['x-setup-token'] !== token) {
        next(new UnauthorizedError());
        return;
    }
    next();
}

// The error middleware returns `missing` alongside the message, so the launcher can tell
// the operator exactly which item is still open.
class SetupIncompleteResponse extends BadRequestError {
    readonly missing: SetupMissingItem[];
    constructor(missing: SetupMissingItem[]) {
        super('The test is not complete.');
        this.missing = missing;
    }
}

@JsonController('/setup-progress')
@UseBefore(requireSetupBridge)
@Service()
export class SetupController {
    constructor(private readonly verification: SetupVerificationService) {}

    @Get('/')
    async report() { return this.verification.report(); }

    @Post('/begin')
    @HttpCode(200)
    async begin() { await this.verification.begin(); return this.verification.report(); }

    @Post('/complete')
    @HttpCode(200)
    async complete(@Body({ required: true }) body: SetupCompleteDto) {
        try {
            await this.verification.complete({ synthetic: body.synthetic, viewer: body.viewer, startup: body.startup });
        } catch (error) {
            if (error instanceof SetupIncompleteError) throw new SetupIncompleteResponse(error.missing);
            throw error;
        }
        return this.verification.report();
    }
}
