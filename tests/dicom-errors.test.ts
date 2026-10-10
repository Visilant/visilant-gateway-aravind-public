import { describeFailure } from '../src/infrastructure/dicom/DicomClient';

// The two failures this box actually produces — an unreachable PACS and a missing
// DCMTK binary — both arrive with empty stderr and no exit code. Before this mapping
// they both rendered as "exited with code unknown", which is the least useful thing
// /health could say about the most common thing that goes wrong.
describe('describeFailure', () => {
    it('names a timeout as unreachable rather than an unknown exit', () => {
        const err = { killed: true, signal: 'SIGTERM', code: null, stderr: '' };
        const detail = describeFailure(err, 'echoscu', 5000);
        expect(detail).toMatch(/timed out after 5s/);
        expect(detail).toMatch(/unreachable/);
        expect(detail).not.toMatch(/unknown/);
    });

    it('tells you how to fix a missing binary', () => {
        const err = { code: 'ENOENT', stderr: '' };
        const detail = describeFailure(err, 'storescu', 30000);
        expect(detail).toMatch(/storescu not found/);
        expect(detail).toMatch(/\*_BIN/);
    });

    it('prefers the tool stderr when there is one', () => {
        const err = { code: 1, stderr: 'E: Association Rejected: called AE unknown' };
        expect(describeFailure(err, 'echoscu', 5000)).toBe('E: Association Rejected: called AE unknown');
    });

    it('falls back to the exit code', () => {
        expect(describeFailure({ code: 70, stderr: '' }, 'img2dcm', 20000)).toBe('exited with code 70');
    });
});
