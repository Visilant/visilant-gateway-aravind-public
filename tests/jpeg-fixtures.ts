// Hand-built JPEG headers: just enough structure for readJpegProfile, no pixel data.

export function segment(marker: number, body: Buffer): Buffer {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
}

// An EXIF APP1 whose IFD0 holds a single Orientation entry, then SOF0 and SOS.
// `orientation` undefined leaves EXIF out altogether.
export function jpegWithOrientation(orientation: number | undefined, little = true): Buffer {
    const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
    if (orientation !== undefined) {
        const tiff = Buffer.alloc(8 + 2 + 12 + 4);
        const u16 = (value: number, at: number) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
        const u32 = (value: number, at: number) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
        tiff.write(little ? 'II' : 'MM', 0, 'latin1');
        u16(42, 2);
        u32(8, 4);
        u16(1, 8);
        u16(0x0112, 10); // Orientation
        u16(3, 12);      // SHORT
        u32(1, 14);      // count
        u16(orientation, 18);
        parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])));
    }
    parts.push(segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0])));
    parts.push(Buffer.from([0xff, 0xda]));
    return Buffer.concat(parts);
}
