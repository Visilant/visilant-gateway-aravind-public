import { Service } from 'typedi';
import type { CaptureEntity } from '../../infrastructure/database';
import { CaptureRepository } from '../../infrastructure/database/repositories';
import { DicomInspector } from '../../infrastructure/dicom';
import { LocalDiskStorage } from '../../infrastructure/storage';
import type { CaptureTagsDto } from '../dto';

export class CaptureNotFoundError extends Error { constructor(id: string) { super(`capture ${id} not found`); } }
export class CaptureFileMissingError extends Error { constructor() { super('file no longer on disk'); } }
@Service()
export class DicomPreviewService {
    constructor(private readonly captureRepository: CaptureRepository, private readonly storage: LocalDiskStorage, private readonly inspector: DicomInspector) {}
    async locate(id: string): Promise<{ capture: CaptureEntity; absolutePath: string }> {
        const capture = await this.captureRepository.findById(id);
        if (!capture) throw new CaptureNotFoundError(id);
        if (!await this.storage.exists(capture.dicom_path)) throw new CaptureFileMissingError();
        return { capture, absolutePath: this.storage.absolutePath(capture.dicom_path) };
    }
    async preview(id: string): Promise<Buffer> {
        try { return await this.inspector.extractJpeg((await this.locate(id)).absolutePath); }
        catch (err) { throw this.readError(err); }
    }
    async tags(id: string): Promise<CaptureTagsDto> {
        try { return await this.inspector.readTags((await this.locate(id)).absolutePath); }
        catch (err) { throw this.readError(err); }
    }
    private readError(err: unknown): unknown {
        // Retention can remove a file after locate's presence check.
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? new CaptureFileMissingError() : err;
    }
    async filePath(id: string): Promise<string> { return (await this.locate(id)).absolutePath; }
}
