import { performance } from 'perf_hooks';
import { diagnosticContext, diagnostics, diagnosticSpan } from '../../infrastructure/diagnostics';
import { promises as fs } from 'fs';
import {
    Authorized,
    BadRequestError,
    Body,
    CurrentUser,
    Get,
    HeaderParam,
    JsonController,
    NotFoundError,
    Param,
    Post,
    QueryParams,
    UploadedFile,
} from 'routing-controllers';
import { Service } from 'typedi';
import { CaptureCreatedDto, CaptureListQueryDto, CreateCaptureDto } from '../../application/dto';
import { CaptureService, SyncWorker } from '../../application/services';
import { UserEntity } from '../../infrastructure/database';
import { InvalidImageError } from '../../infrastructure/dicom';
import { captureUploadOptions } from '../upload';
import { assertUuid, parseMultipartDto } from '../validation';
import { mapScreeningError } from './screening.controller';

@JsonController('/captures')
@Authorized()
@Service()
export class CaptureController {
    constructor(
        private readonly captureService: CaptureService,
        private readonly syncWorker: SyncWorker,
    ) {}

    @Post('/')
    async create(
        @UploadedFile('file', { options: captureUploadOptions, required: true })
        file: Express.Multer.File,
        @Body() body: Record<string, unknown>,
        @CurrentUser() user: UserEntity,
        @HeaderParam('idempotency-key') idempotencyKey?: string,
    ): Promise<CaptureCreatedDto> {
        try {
            const startedMs = diagnosticContext.getStore()?.started_ms;
            diagnostics.event('capture.before_controller', { bytes: file.size }, startedMs !== undefined ? performance.now() - startedMs : undefined);
            // Multipart carries worklist_entry as a JSON string, so it is parsed and
            // validated here rather than by routing-controllers.
            const input = await diagnosticSpan('capture.validate', async () => parseMultipartDto(CreateCaptureDto, body, ['worklist_entry', 'ai_assessment']));

            return await this.captureService.create(input, file.path, user.id, idempotencyKey ?? null);
        } catch (err) {
            // Anything that fails before the service takes ownership leaves the upload
            // behind, and it is a photograph of a patient.
            await fs.rm(file.path, { force: true }).catch(() => undefined);
            if (err instanceof InvalidImageError) throw new BadRequestError(err.message);
            throw mapScreeningError(err);
        }
    }

    // Drains the queue now instead of waiting for the next interval. Useful when an
    // operator has just brought the archive back up and wants to see it clear.
    @Post('/sync')
    sync(): Promise<{ sent: number; failed: number }> {
        return this.syncWorker.tick();
    }

    @Post('/:id/retry')
    async retry(@Param('id') id: string): Promise<{ id: string; status: string }> {
        const result = await this.captureService.retry(id);
        if (!result) throw new NotFoundError(`capture ${id} not found`);
        return result;
    }

    @Get('/')
    list(@QueryParams() query: CaptureListQueryDto) {
        return this.captureService.list(query);
    }

    @Get('/:id')
    async get(@Param('id') value: string) {
        const id = assertUuid(value, 'capture id');
        const row = await this.captureService.get(id);
        if (!row) throw new NotFoundError(`capture ${id} not found`);
        return row;
    }
}
