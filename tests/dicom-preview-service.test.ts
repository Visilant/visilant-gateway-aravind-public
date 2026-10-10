import 'reflect-metadata';
import { CaptureFileMissingError, CaptureNotFoundError, DicomPreviewService } from '../src/application/services/DicomPreviewService';
import { mapPreviewError } from '../src/presentation/controllers/dicom-preview.controller';
import { DicomJsonParseError, PixelDataNotEncapsulatedError } from '../src/infrastructure/dicom';
import { HttpError } from 'routing-controllers';

const repository = { findById: jest.fn() };
const storage = { exists: jest.fn(), absolutePath: jest.fn() };
const inspector = { readTags: jest.fn(), extractJpeg: jest.fn() };
let service: DicomPreviewService;
beforeEach(() => {
    jest.resetAllMocks(); repository.findById.mockResolvedValue({ id: 'id', dicom_path: 'key' });
    storage.exists.mockResolvedValue(true); storage.absolutePath.mockReturnValue('/storage/key');
    service = new DicomPreviewService(repository as never, storage as never, inspector as never);
});
test('an unknown row is distinct from a missing file', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(service.preview('id')).rejects.toBeInstanceOf(CaptureNotFoundError);
    expect(storage.exists).not.toHaveBeenCalled();
});
test('a removed file never reaches the inspector', async () => {
    storage.exists.mockResolvedValue(false);
    for (const method of ['preview', 'tags', 'filePath'] as const) await expect(service[method]('id')).rejects.toBeInstanceOf(CaptureFileMissingError);
    expect(inspector.readTags).not.toHaveBeenCalled(); expect(inspector.extractJpeg).not.toHaveBeenCalled();
});
test('tags and previews use the storage-confined absolute path', async () => {
    const bytes = Buffer.from([0xff, 0xd8]); inspector.extractJpeg.mockResolvedValue(bytes); inspector.readTags.mockResolvedValue({ patient_name: 'SYNTHETIC' });
    expect(await service.preview('id')).toBe(bytes); expect(await service.tags('id')).toEqual({ patient_name: 'SYNTHETIC' });
    expect(inspector.readTags).toHaveBeenCalledWith('/storage/key'); expect(inspector.extractJpeg).toHaveBeenCalledWith('/storage/key');
    expect(await service.filePath('id')).toBe('/storage/key');
});
test.each([[new CaptureNotFoundError('id'), 404], [new CaptureFileMissingError(), 404], [new PixelDataNotEncapsulatedError(), 502], [new DicomJsonParseError(), 502]])('maps %s to HTTP %i', (err, code) => {
    expect((mapPreviewError(err) as HttpError).httpCode).toBe(code);
});

test('a capture removed after the presence check returns the missing-file error', async () => {
    inspector.readTags.mockRejectedValue(Object.assign(new Error('removed'), { code: 'ENOENT' }));
    await expect(service.tags('id')).rejects.toBeInstanceOf(CaptureFileMissingError);
});
