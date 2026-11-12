import type { Response } from 'express';
import { once } from 'events';
import type { ValidationError } from 'class-validator';
import { Authorized, Body, Get, JsonController, OnUndefined, Post, QueryParams, Res } from 'routing-controllers';
import { Inject, Service } from 'typedi';
import { PHONE_EVENT_TYPES, TelemetryBatchDto, TelemetryExportQueryDto, TelemetryIngestResultDto } from '../../application/dto';
import { TelemetryService } from '../../application/services';
import { UserRole } from '../../infrastructure/database';
import type { Logger } from '../../infrastructure/logger';
import { LOGGER } from '../../tokens';
import { validateDto } from '../validation';

@JsonController('/telemetry')
@Service()
export class TelemetryController {
    constructor(
        private readonly telemetry: TelemetryService,
        @Inject(LOGGER) private readonly logger: Logger,
    ) {}

    // Size limits (100 events, 256 KB) are applied before this, in server.ts.
    @Post('/events')
    @Authorized()
    @OnUndefined(204)
    async events(@Body({ validate: false }) body: unknown): Promise<TelemetryIngestResultDto | undefined> {
        // Off: answer, store nothing, and do not spend effort validating what is dropped.
        if (!this.telemetry.enabled) return undefined;
        let batch: TelemetryBatchDto;
        try {
            batch = validateDto(TelemetryBatchDto, body);
        } catch (err) {
            this.logger.warn(`telemetry rejected: ${describeRejection(body, (err as { errors?: ValidationError[] }).errors ?? [])}`);
            throw err;
        }
        return this.telemetry.ingest(batch.events);
    }

    // NDJSON of the unsent rows, for a site that stays offline. See docs/telemetry.md.
    @Get('/export')
    @Authorized(UserRole.ADMIN)
    async export(@QueryParams() query: TelemetryExportQueryDto, @Res() res: Response): Promise<Response> {
        res.set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': `attachment; filename="${this.telemetry.exportFilename()}"`,
            'Cache-Control': 'no-store',
        });
        res.flushHeaders();
        try {
            for await (const chunk of this.telemetry.exportUnsent(query.since ?? null)) {
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

// The event type and the field path, never a value. A type is logged only when it is
// one of ours, because until it is checked it is whatever the client sent.
function describeRejection(body: unknown, errors: ValidationError[]): string {
    const paths = errors.flatMap((error) => leafPaths(error, []));
    const events = (body as { events?: unknown })?.events;
    const described = paths.slice(0, 5).map((path) => {
        const index = path[0] === 'events' && /^\d+$/.test(path[1] ?? '') ? Number(path[1]) : null;
        const type = index !== null && Array.isArray(events) ? (events[index] as { type?: unknown } | undefined)?.type : undefined;
        const known = typeof type === 'string' && (PHONE_EVENT_TYPES as readonly string[]).includes(type);
        return `${index === null ? 'batch' : known ? type : 'unknown type'} ${path.join('.')}`;
    });
    return described.join('; ') + (paths.length > 5 ? `; and ${paths.length - 5} more` : '') || 'malformed batch';
}

function leafPaths(error: ValidationError, parent: string[]): string[][] {
    const path = [...parent, error.property];
    const children = error.children ?? [];
    return children.length ? children.flatMap((child) => leafPaths(child, path)) : [path];
}
