import os from 'os';
import multer from 'multer';
import { BadRequestError } from 'routing-controllers';

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

// Captures land in the OS temp directory and are moved into the DICOM object by the
// service, which deletes this copy immediately afterwards — it holds the photograph, so
// it should not outlive the request.
export const captureUploadOptions: multer.Options = {
    storage: multer.diskStorage({ destination: os.tmpdir() }),
    limits: { fileSize: MAX_CAPTURE_BYTES, files: 1 },
    fileFilter: (_req, file, callback) => {
        if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
            callback(null, true);
            return;
        }
        callback(new BadRequestError('capture must be a JPEG image'));
    },
};
