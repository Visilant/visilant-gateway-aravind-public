import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ExpressErrorMiddlewareInterface, HttpError, Middleware } from 'routing-controllers';
import { Inject, Service } from 'typedi';
import { LOGGER } from '../../tokens';
import type { Logger } from '../../infrastructure/logger';

const publicServerErrors = new Set([
    'recording could not be started; see the gateway log',
    'pixel data not encapsulated JPEG',
    'DICOM JSON could not be parsed',
]);

interface ValidationFailure extends HttpError {
    errors?: unknown[];
}

// Owns every error leaving the API.
//
// Errors here carry DCMTK output and absolute file paths, and a validation failure can
// carry the payload that failed — which on this service means patient demographics.
// So the client gets the status and a flat message, the log gets the detail, and
// neither gets the offending value.
@Middleware({ type: 'after' })
@Service()
export class ErrorHandlerMiddleware implements ExpressErrorMiddlewareInterface {
    constructor(@Inject(LOGGER) private readonly logger: Logger) {}

    error(error: unknown, request: Request, response: Response, _next: NextFunction): void {
        const status = error instanceof HttpError ? error.httpCode : multerStatus(error);
        const message = error instanceof Error ? error.message : 'unexpected error';

        if (status >= 500) {
            this.logger.error(`${request.method} ${request.path} failed: ${message}`);
        }

        const body: Record<string, unknown> = {
            error: status >= 500 && !publicServerErrors.has(message) ? 'internal error' : message,
        };

        // routing-controllers attaches the class-validator failures here. They are
        // already value-stripped by the validation options in server.ts, so the field
        // names and reasons are safe to return — they are what the app needs to fix
        // its request.
        const failures = (error as ValidationFailure)?.errors;
        if (status === 400 && Array.isArray(failures)) {
            body.details = failures;
        }

        // Setup completion names the items still open, for example ['startup_confirmation'].
        // Those are internal enum values, never patient data.
        const missing = (error as { missing?: unknown })?.missing;
        if (status === 400 && Array.isArray(missing)) {
            body.missing = missing;
        }

        response.status(status).json(body);
    }
}

// Upload limits are the client's problem, not ours: too large is 413, anything else
// multer rejects (a second file, a wrong field name) is a malformed request.
function multerStatus(error: unknown): number {
    if (!(error instanceof MulterError)) return 500;
    return error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
}
