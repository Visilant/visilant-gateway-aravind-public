import type { Response } from 'express';
import { once } from 'events';
import type { ValidationError } from 'class-validator';
import { Authorized, BadRequestError, Body, CurrentUser, Get, HttpError, JsonController, OnUndefined, Post, QueryParams, Res, UnauthorizedError, UseBefore } from 'routing-controllers';
import { Inject, Service } from 'typedi';
import { PHONE_EVENT_TYPES, TelemetryBatchDto, TelemetryExportQueryDto, TelemetryIngestResultDto } from '../../application/dto';
import { TelemetryCursorNotFoundError, TelemetryEventTooLargeError, TelemetryService, TelemetrySignInRequiredError } from '../../application/services';
import { UserEntity, UserRole } from '../../infrastructure/database';
import type { Logger } from '../../infrastructure/logger';
import { LOGGER } from '../../tokens';
import { TelemetryAccess } from '../middlewares/telemetry-access.middleware';
import { validateDto } from '../validation';

@JsonController('/telemetry')
@Service()
export class TelemetryController {
    constructor(
        private readonly telemetry: TelemetryService,
        @Inject(LOGGER) private readonly logger: Logger,
    ) {}

    // Size limits (100 events, 256 KB) are applied before this, in server.ts. Telemetry
    // off, the optional token and the limits for unsigned requests are TelemetryAccess.
    @Post('/events')
    @UseBefore(TelemetryAccess)
    @OnUndefined(204)
    async events(
        @Body({ validate: false }) body: unknown,
        @CurrentUser({ required: false }) user: UserEntity | undefined,
    ): Promise<TelemetryIngestResultDto> {
        const batch = this.parse(body);
        try {
            return await this.telemetry.ingest(batch.events, !!user);
        } catch (err) {
            throw mapTelemetryError(err);
        }
    }

    private parse(body: unknown): TelemetryBatchDto {
        try {
            return validateDto(TelemetryBatchDto, body);
        } catch (err) {
            const errors = (err as { errors?: ValidationError[] }).errors;
            if (!errors) throw err;
            const rejections = describeRejections(errors);
            const events = (body as { events?: unknown })?.events;
            this.logger.warn(`telemetry rejected: ${rejections.slice(0, 5).map((r) => {
                if (r.event === null) return `batch ${r.field} ${r.reason}`;
                // A type is logged only when it is one of ours: until checked it is client text.
                const type = Array.isArray(events) ? (events[r.event] as { type?: unknown } | undefined)?.type : undefined;
                const known = typeof type === 'string' && (PHONE_EVENT_TYPES as readonly string[]).includes(type);
                return `event ${r.event} (${known ? type : 'unknown type'}) ${r.field} ${r.reason}`;
            }).join('; ')}${rejections.length > 5 ? `; and ${rejections.length - 5} more` : ''}`);
            const error = new BadRequestError('telemetry request failed validation');
            (error as BadRequestError & { errors?: unknown }).errors = rejections;
            throw error;
        }
    }

    // NDJSON of the unsent rows, for a site that stays offline. See docs/telemetry.md.
    @Get('/export')
    @Authorized(UserRole.ADMIN)
    async export(@QueryParams() query: TelemetryExportQueryDto, @Res() res: Response): Promise<Response> {
        let chunks: AsyncGenerator<string>;
        try {
            chunks = await this.telemetry.exportUnsent(query.since ?? null);
        } catch (err) {
            throw mapTelemetryError(err);
        }
        res.set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': `attachment; filename="${this.telemetry.exportFilename()}"`,
            'Cache-Control': 'no-store',
        });
        res.flushHeaders();
        try {
            for await (const chunk of chunks) {
                if (res.destroyed) break;
                if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
            }
            res.end();
        } catch (err) {
            // Headers are gone, so the only signal left is a cut connection.
            this.logger.error(`telemetry export failed part way: ${err instanceof Error ? err.message : String(err)}`);
            res.destroy();
        }
        return res;
    }
}

export function mapTelemetryError(err: unknown): unknown {
    if (err instanceof TelemetrySignInRequiredError) return new UnauthorizedError(err.message);
    if (err instanceof TelemetryEventTooLargeError) return new HttpError(413, err.message);
    if (err instanceof TelemetryCursorNotFoundError) return new BadRequestError(err.message);
    return err;
}

// What a 400 and the log may say about a rejected field. Key names the client sent
// are client text, like values, so an unknown key is reported as `<unknown key>`.
// Every other path segment is one of our DTO property names or an array index.
export interface TelemetryRejection { event: number | null; field: string; reason: 'unknown_key' | 'missing' | 'invalid' }

export function describeRejections(errors: ValidationError[]): TelemetryRejection[] {
    return errors.flatMap((error) => leaves(error, [])).map(({ path, error }) => {
        const unknownKey = !!error.constraints?.whitelistValidation;
        const segments = unknownKey ? [...path.slice(0, -1), '<unknown key>'] : path;
        const event = segments[0] === 'events' && /^\d+$/.test(segments[1] ?? '') ? Number(segments[1]) : null;
        const field = (event === null ? segments : segments.slice(2)).join('.') || 'events';
        const reason = unknownKey ? 'unknown_key' : error.constraints?.isDefined ? 'missing' : 'invalid';
        return { event, field, reason };
    });
}

function leaves(error: ValidationError, parent: string[]): Array<{ path: string[]; error: ValidationError }> {
    const path = [...parent, error.property];
    const own = error.constraints && Object.keys(error.constraints).length ? [{ path, error }] : [];
    return [...own, ...(error.children ?? []).flatMap((child) => leaves(child, path))];
}
