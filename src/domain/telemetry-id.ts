import { createHash } from 'crypto';

// A UUIDv7 that is the same every time for the same key: the time from `msecs`, the
// rest from a hash of the key. For a gateway event that may be written again after a
// power cut, so the outbox's INSERT OR IGNORE keeps one copy.
export function deterministicUuidV7(key: string, msecs: number): string {
    const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
    const time = BigInt(Math.max(0, Math.floor(msecs)));
    for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn);
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
