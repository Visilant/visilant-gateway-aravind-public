import type { NextFunction, Request, Response } from 'express';
import { ExpressMiddlewareInterface, HttpError } from 'routing-controllers';
import { Service } from 'typedi';
import {
    ANONYMOUS_REQUESTS_PER_MINUTE, ANONYMOUS_REQUESTS_PER_MINUTE_ALL, MAX_ANONYMOUS_BODY_BYTES,
} from '../../application/dto';
import { AuthService, TelemetryService } from '../../application/services';
import { FixedWindowLimiter } from '../rate-limiter';

const MINUTE_MS = 60_000;

// Access to POST /telemetry/events, as route middleware so the controller stays HTTP
// only. A token is optional there: phones send a few types before sign-in.
//
// - Telemetry off: 204 at once, before any work.
// - A valid token: req.user is set and nothing else applies.
// - No valid token (none, expired, invalid): at most 32 KB a request, 30 requests a
//   minute per client IP and 120 a minute in all. Which types such a request may carry
//   is the service's rule.
@Service()
export class TelemetryAccess implements ExpressMiddlewareInterface {
    private readonly perClient = new FixedWindowLimiter(ANONYMOUS_REQUESTS_PER_MINUTE, MINUTE_MS);
    private readonly overall = new FixedWindowLimiter(ANONYMOUS_REQUESTS_PER_MINUTE_ALL, MINUTE_MS);

    constructor(
        private readonly telemetry: TelemetryService,
        private readonly auth: AuthService,
    ) {}

    async use(req: Request, res: Response, next: NextFunction): Promise<void> {
        if (!this.telemetry.enabled) {
            res.status(204).end();
            return;
        }
        const user = await this.auth.authenticate(req.headers.authorization).catch(() => null);
        if (user) {
            (req as Request & { user?: unknown }).user = user;
            next();
            return;
        }
        if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > MAX_ANONYMOUS_BODY_BYTES) {
            next(new HttpError(413, `telemetry request without sign-in is over ${MAX_ANONYMOUS_BODY_BYTES / 1024} KB; send fewer events, or sign in`));
            return;
        }
        const client = this.perClient.take(req.socket.remoteAddress ?? 'unknown');
        if (!client.allowed) {
            this.refuse(res, next, client.retryAfterSeconds, `more than ${ANONYMOUS_REQUESTS_PER_MINUTE} telemetry requests a minute from this phone without sign-in; wait, or sign in`);
            return;
        }
        const all = this.overall.take('all');
        if (!all.allowed) {
            this.refuse(res, next, all.retryAfterSeconds, `more than ${ANONYMOUS_REQUESTS_PER_MINUTE_ALL} telemetry requests a minute from all phones without sign-in; wait, or sign in`);
            return;
        }
        next();
    }

    private refuse(res: Response, next: NextFunction, retryAfterSeconds: number, message: string): void {
        res.setHeader('Retry-After', String(retryAfterSeconds));
        next(new HttpError(429, message));
    }
}
