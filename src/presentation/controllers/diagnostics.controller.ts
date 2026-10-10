import type { Response } from 'express';
import { Authorized, BadRequestError, Body, Get, HttpError, InternalServerError, JsonController, NotFoundError, Param, Put, Res } from 'routing-controllers';
import { Service } from 'typedi';
import { RecordingDto } from '../../application/dto';
import { DiagnosticsService, InvalidDiagnosticIdError, RecordingLockedError, RecordingStartError, RunNotFoundError, SegmentNotFoundError } from '../../application/services/DiagnosticsService';
import { assertUuid } from '../validation';

export function mapDiagnosticsError(err: unknown): unknown {
    if (err instanceof RecordingLockedError) return new HttpError(409, err.message);
    if (err instanceof InvalidDiagnosticIdError) return new BadRequestError(err.message);
    if (err instanceof SegmentNotFoundError || err instanceof RunNotFoundError) return new NotFoundError(err.message);
    if (err instanceof RecordingStartError) return new InternalServerError(err.message);
    return err;
}
@JsonController('/diagnostics')
@Authorized()
@Service()
export class DiagnosticsController {
    constructor(private readonly service: DiagnosticsService) {}
    @Get('/')
    async overview() { try { return await this.service.overview(); } catch (err) { throw mapDiagnosticsError(err); } }
    @Put('/recording')
    async recording(@Body() body: RecordingDto) { try { return await this.service.setRecording(body.enabled); } catch (err) { throw mapDiagnosticsError(err); } }
    @Get('/segments/:id')
    async segment(@Param('id') id: string) { try { return await this.service.segment(assertUuid(id, 'segment id')); } catch (err) { throw mapDiagnosticsError(err); } }
    @Get('/runs/:runId')
    async run(@Param('runId') id: string) { try { return await this.service.run(assertUuid(id, 'run id')); } catch (err) { throw mapDiagnosticsError(err); } }
    @Get('/segments/:id/archive')
    async archive(@Param('id') id: string, @Res() res: Response) {
        try {
            const archive = await this.service.archive(assertUuid(id, 'segment id'));
            archive.stream.on('error', () => {
                if (!res.headersSent) res.status(500).json({ error: 'archive failed' }); else res.destroy();
            });
            res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${archive.id}.zip"`, 'Cache-Control': 'no-store' });
            res.flushHeaders();
            archive.stream.pipe(res);
            return res;
        } catch (err) { throw mapDiagnosticsError(err); }
    }
}
