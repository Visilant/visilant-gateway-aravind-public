import { deriveUid } from '../src/infrastructure/dicom/util';

const ROOT = '1.2.826.0.1.3680043.10.1338';

describe('deriveUid', () => {
    // A retry re-sends the same object, so the UIDs it carries must not change between
    // attempts — otherwise every retry deposits another copy in the archive.
    it('is deterministic for the same seed', () => {
        expect(deriveUid('instance:abc', ROOT)).toBe(deriveUid('instance:abc', ROOT));
    });

    it('separates different seeds', () => {
        expect(deriveUid('instance:abc', ROOT)).not.toBe(deriveUid('instance:abd', ROOT));
    });

    it('stays within the 64-character DICOM UID limit', () => {
        for (const seed of ['a', 'instance:'.padEnd(200, 'x'), '']) {
            expect(deriveUid(seed, ROOT).length).toBeLessThanOrEqual(64);
        }
    });

    it('produces a valid UID: dot-separated digits, no leading zero component', () => {
        const uid = deriveUid('instance:abc', ROOT);
        expect(uid).toMatch(/^[0-9]+(\.[0-9]+)*$/);
        for (const component of uid.split('.')) {
            expect(component.length === 1 || !component.startsWith('0')).toBe(true);
        }
    });

    it('tolerates a root given with a trailing dot', () => {
        expect(deriveUid('x', `${ROOT}.`)).toBe(deriveUid('x', ROOT));
    });

    it('refuses a root too long to leave room for a suffix', () => {
        expect(() => deriveUid('x', '1'.padEnd(70, '.1'))).toThrow(/too long/);
    });
});
