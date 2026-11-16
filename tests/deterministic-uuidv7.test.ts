import { deterministicUuidV7 } from '../src/domain/telemetry-id';

test('is a lowercase UUIDv7 carrying the given time, the same for the same key', () => {
    const id = deterministicUuidV7('ai.assessed:capture-1', Date.parse('2026-11-12T03:00:00.000Z'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(Date.parse('2026-11-12T03:00:00.000Z'));
    expect(deterministicUuidV7('ai.assessed:capture-1', Date.parse('2026-11-12T03:00:00.000Z'))).toBe(id);
    expect(deterministicUuidV7('ai.assessed:capture-2', Date.parse('2026-11-12T03:00:00.000Z'))).not.toBe(id);
});
