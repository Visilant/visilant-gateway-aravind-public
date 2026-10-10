// Minimal JPEG header reader.
//
// img2dcm encapsulates JPEG pixel data without decoding it, and only accepts a baseline
// (SOF0) frame — a progressive JPEG is rejected. Rather than re-encoding every capture
// through ImageMagick unconditionally, we read the frame marker and normalise only when
// we have to.
//
// The EXIF orientation is read for the same reason. Android cameras record a rotated
// device as an orientation tag rather than rotating the pixels, and DICOM has nowhere to
// carry that tag — img2dcm drops it, so the PACS shows the raw sensor frame, upside down
// for whichever eye was shot with the phone turned round. A capture with any orientation
// other than "as stored" has to be re-encoded upright before conversion.

const SOF_BASELINE = 0xc0;
const APP1 = 0xe1;
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const TAG_ORIENTATION = 0x0112;

// Markers that carry no length field and are skipped whole.
const STANDALONE = new Set([0xd8, 0xd9, 0x01]);

export interface JpegProfile {
    isJpeg: boolean;
    isBaseline: boolean;
    // EXIF Orientation, 1-8. 1 (pixels already upright) when the file carries none.
    orientation: number;
}

export function readJpegProfile(buffer: Buffer): JpegProfile {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return { isJpeg: false, isBaseline: false, orientation: 1 };
    }

    let orientation = 1;
    let offset = 2;
    while (offset < buffer.length - 1) {
        if (buffer[offset] !== 0xff) {
            offset++; // fill byte or padding; resynchronise
            continue;
        }

        const marker = buffer[offset + 1];
        if (marker === 0xff) {
            offset++;
            continue;
        }
        if (STANDALONE.has(marker)) {
            offset += 2;
            continue;
        }
        // Start of Scan — pixel data follows, so the frame header is already behind us.
        if (marker === 0xda) break;

        // SOFn: 0xC0-0xCF excluding DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { isJpeg: true, isBaseline: marker === SOF_BASELINE, orientation };
        }

        if (offset + 3 >= buffer.length) break;
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) break;
        if (marker === APP1) {
            const segment = buffer.subarray(offset + 4, Math.min(buffer.length, offset + 2 + length));
            orientation = readExifOrientation(segment) ?? orientation;
        }
        offset += 2 + length;
    }

    // A JPEG whose frame header we could not find is treated as needing normalisation
    // rather than being passed to img2dcm to fail there.
    return { isJpeg: true, isBaseline: false, orientation };
}

// Reads Orientation from IFD0 of an APP1 Exif segment. Undefined for anything that is
// not EXIF (XMP also lives in APP1), is truncated, or holds an out-of-range value.
function readExifOrientation(segment: Buffer): number | undefined {
    if (segment.length < EXIF_HEADER.length + 8 || !segment.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER)) {
        return undefined;
    }
    const tiff = segment.subarray(EXIF_HEADER.length);
    const order = tiff.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return undefined;
    const little = order === 'II';
    const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
    const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));

    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return undefined;
    const entries = u16(ifd);
    for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > tiff.length) return undefined;
        if (u16(entry) !== TAG_ORIENTATION) continue;
        // SHORT, count 1: the value sits left-justified in the 4-byte value field.
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : undefined;
    }
    return undefined;
}
