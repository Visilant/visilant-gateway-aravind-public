import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { HttpError } from 'routing-controllers';
import { MAX_BODY_BYTES, MAX_EVENTS_PER_REQUEST } from '../application/dto';

// POST /telemetry/events: at most 256 KB and 100 events, otherwise 413. Both are
// checked before validation, so an oversized batch is never walked.
export function telemetryBodyLimits(): RequestHandler[] {
    const parse = express.json({ limit: MAX_BODY_BYTES });
    return [
        (req: Request, res: Response, next: NextFunction) => parse(req, res, (err?: unknown) => {
            if ((err as { type?: unknown } | undefined)?.type === 'entity.too.large') {
                next(new HttpError(413, `telemetry request is over ${MAX_BODY_BYTES / 1024} KB; send fewer events per request`));
            } else next(err);
        }),
        (req: Request, _res: Response, next: NextFunction) => {
            const events = (req.body as { events?: unknown } | undefined)?.events;
            if (Array.isArray(events) && events.length > MAX_EVENTS_PER_REQUEST) {
                next(new HttpError(413, `telemetry request has ${events.length} events; the limit is ${MAX_EVENTS_PER_REQUEST} per request`));
            } else next();
        },
    ];
}
