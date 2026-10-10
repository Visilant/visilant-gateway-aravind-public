import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { readJpegProfile } from '../src/infrastructure/image/jpeg';
import { jpegWithOrientation, segment } from './jpeg-fixtures';

// img2dcm accepts only a baseline frame, and re-encoding every capture just in case
// would mean shipping ImageMagick to every centre. This detection is what lets the
// normalise step be conditional, so it is worth checking against real encoder output
// rather than hand-built bytes.
const dir = mkdtempSync(path.join(tmpdir(), 'jpeg-test-'));
const baseline = path.join(dir, 'baseline.jpg');
const progressive = path.join(dir, 'progressive.jpg');
let haveMagick = true;

beforeAll(() => {
    try {
        execFileSync('magick', ['-size', '64x64', 'gradient:navy-white', baseline]);
        execFileSync('magick', [baseline, '-interlace', 'plane', progressive]);
    } catch {
        haveMagick = false;
    }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readJpegProfile', () => {
    it('identifies a baseline JPEG', () => {
        if (!haveMagick) return;
        expect(readJpegProfile(readFileSync(baseline))).toEqual({ isJpeg: true, isBaseline: true, orientation: 1 });
    });

    it('identifies a progressive JPEG as needing normalisation', () => {
        if (!haveMagick) return;
        expect(readJpegProfile(readFileSync(progressive))).toEqual({ isJpeg: true, isBaseline: false, orientation: 1 });
    });

    it('rejects data that is not a JPEG at all', () => {
        expect(readJpegProfile(Buffer.from('not an image'))).toEqual({ isJpeg: false, isBaseline: false, orientation: 1 });
        expect(readJpegProfile(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toEqual({ isJpeg: false, isBaseline: false, orientation: 1 });
    });

    it('does not treat a truncated file as baseline', () => {
        // Better to re-encode unnecessarily than to hand img2dcm something it rejects.
        expect(readJpegProfile(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).isBaseline).toBe(false);
    });
});

// Android cameras record a turned phone as an EXIF tag instead of rotating the pixels,
// and img2dcm drops EXIF. Missing this is what put one eye upside down in the PACS.
describe('readJpegProfile orientation', () => {
    it.each([[6, true], [3, false]])('reads orientation %i (little-endian %s)', (value, little) => {
        expect(readJpegProfile(jpegWithOrientation(value, little))).toEqual({ isJpeg: true, isBaseline: true, orientation: value });
    });

    it('treats a JPEG without EXIF as upright', () => {
        expect(readJpegProfile(jpegWithOrientation(undefined)).orientation).toBe(1);
    });

    it('ignores an APP1 segment that is XMP rather than EXIF', () => {
        const xmp = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1'));
        const jpeg = jpegWithOrientation(undefined);
        expect(readJpegProfile(Buffer.concat([jpeg.subarray(0, 2), xmp, jpeg.subarray(2)])).orientation).toBe(1);
    });

    it('ignores an out-of-range orientation value', () => {
        expect(readJpegProfile(jpegWithOrientation(9)).orientation).toBe(1);
    });

    it('does not read past a truncated EXIF segment', () => {
        const jpeg = jpegWithOrientation(6);
        expect(readJpegProfile(jpeg.subarray(0, 20))).toEqual({ isJpeg: true, isBaseline: false, orientation: 1 });
    });
});
