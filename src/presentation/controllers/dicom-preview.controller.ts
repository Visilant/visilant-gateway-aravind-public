import { createReadStream } from 'fs';
import type { Response } from 'express';
import { Authorized, Get, HttpError, JsonController, NotFoundError, Param, Res } from 'routing-controllers';
import { Service } from 'typedi';
import { CaptureFileMissingError, CaptureNotFoundError, DicomPreviewService } from '../../application/services/DicomPreviewService';
import { DicomJsonParseError, PixelDataNotEncapsulatedError } from '../../infrastructure/dicom';
import { assertUuid } from '../validation';

export function mapPreviewError(err: unknown): unknown {
    if (err instanceof CaptureFileMissingError || err instanceof CaptureNotFoundError) return new NotFoundError(err.message);
    if (err instanceof DicomJsonParseError || err instanceof PixelDataNotEncapsulatedError) return new HttpError(502, err.message);
    return err;
}
@JsonController('/captures')
@Authorized()
@Service()
export class DicomPreviewController {
    constructor(private readonly service: DicomPreviewService) {}
    @Get('/:id/preview')
    async preview(@Param('id') value: string, @Res() res: Response) {
        try {
            const id = assertUuid(value, 'capture id');
            const bytes = await this.service.preview(id);
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).end(bytes);
            return res;
        } catch (err) { throw mapPreviewError(err); }
    }
    @Get('/:id/tags')
    async tags(@Param('id') value: string, @Res() res: Response) {
        try {
            const id = assertUuid(value, 'capture id');
            res.set('Cache-Control', 'no-store');
            return await this.service.tags(id);
        } catch (err) { throw mapPreviewError(err); }
    }
    @Get('/:id/dicom')
    async dicom(@Param('id') value: string, @Res() res: Response) {
        try {
            const id = assertUuid(value, 'capture id');
            const file = await this.service.filePath(id);
            const stream = createReadStream(file);
            stream.on('error', () => {
                if (!res.headersSent) res.status(404).json({ error: 'file no longer on disk' }); else res.destroy();
            });
            res.on('close', () => stream.destroy());
            res.set({ 'Content-Type': 'application/dicom', 'Content-Disposition': `attachment; filename="${id}.dcm"`, 'Cache-Control': 'no-store' });
            res.flushHeaders();
            stream.pipe(res);
            return res;
        } catch (err) { throw mapPreviewError(err); }
    }
}
