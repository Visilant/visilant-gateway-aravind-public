import 'reflect-metadata';
import { HttpError } from 'routing-controllers';
import { assertUuid } from '../src/presentation/validation';
import { mapDiagnosticsError } from '../src/presentation/controllers/diagnostics.controller';
import { InvalidDiagnosticIdError, RecordingLockedError, RecordingStartError, RunNotFoundError, SegmentNotFoundError } from '../src/application/services/DiagnosticsService';
const id = 'ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF';
test('UUIDs are normalized and malformed paths rejected', () => {
    expect(assertUuid(id, 'id')).toBe(id.toLowerCase()); expect(assertUuid(id.toLowerCase(), 'id')).toBe(id.toLowerCase());
    for (const value of ['../x', '1234']) expect(() => assertUuid(value, 'id')).toThrow('id must be a UUID');
});
test.each([
    [new RecordingLockedError(), 409], [new InvalidDiagnosticIdError('id'), 400],
    [new SegmentNotFoundError(id), 404], [new RunNotFoundError(id), 404], [new RecordingStartError(), 500],
])('maps %s to %i', (error, status) => expect((mapDiagnosticsError(error) as HttpError).httpCode).toBe(status));
test('leaves other errors unchanged', () => { const error = new Error('other'); expect(mapDiagnosticsError(error)).toBe(error); });

test('the envelope preserves a streaming response before the first byte is sent', () => {
    const { ResponseEnvelopeInterceptor } = require('../src/presentation/response.interceptor');
    const response = { headersSent: false };
    expect(new ResponseEnvelopeInterceptor().intercept({ request: {}, response }, response)).toBe(response);
});
