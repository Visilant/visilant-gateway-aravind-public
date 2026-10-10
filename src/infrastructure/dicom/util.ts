import { createHash } from 'crypto';

// A DICOM UID is at most 64 characters: dot-separated numeric components, no leading
// zeros, rooted at an OID that belongs to the organisation.
//
// Series and SOP UIDs are DERIVED from a stable seed rather than randomly generated, so
// rebuilding or re-sending a capture produces the same UIDs every time. That keeps a
// C-STORE retry idempotent — the archive recognises the repeat instead of accumulating
// duplicate copies of the same photograph.
//
// Study Instance UID is never derived here: it comes from the worklist, because an image
// stored under a UID the RIS did not assign lands in a different study from the order.
export function deriveUid(seed: string, root: string): string {
    const base = root.endsWith('.') ? root.slice(0, -1) : root;
    const digits = BigInt('0x' + createHash('sha256').update(seed).digest('hex')).toString();
    const maxDigits = 64 - base.length - 1; // room for "base." plus the numeric tail
    if (maxDigits < 1) {
        throw new Error(`study_uid_root is too long to derive a UID from: ${root}`);
    }
    return `${base}.${digits.slice(0, maxDigits)}`;
}
