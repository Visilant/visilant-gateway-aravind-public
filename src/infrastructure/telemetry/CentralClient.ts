import { Service } from 'typedi';

const TIMEOUT_MS = 30_000;

// A push that central did not confirm. `reason` is an HTTP status or a network error
// code, which is what the log needs; never the token, never the body.
export class CentralPushError extends Error {
    constructor(readonly reason: string, message: string) {
        super(message);
    }
}

// POST <central_url>/v1/telemetry/batch. Central stores the events with
// ON CONFLICT (event_id) DO NOTHING and returns every event_id it now holds.
@Service()
export class CentralClient {
    async pushBatch(centralUrl: string, token: string, events: object[]): Promise<string[]> {
        let response: Response;
        try {
            response = await fetch(`${centralUrl.replace(/\/+$/, '')}/v1/telemetry/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ events }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (err) {
            const code = networkCode(err);
            throw new CentralPushError(code, `could not reach central (${code})`);
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new CentralPushError(`HTTP ${response.status}`, `central answered HTTP ${response.status}`);
        }
        const body = await response.json().catch(() => null) as { event_ids?: unknown } | null;
        if (!Array.isArray(body?.event_ids) || !body.event_ids.every((id) => typeof id === 'string')) {
            throw new CentralPushError('bad_reply', 'central answered without a list of event_ids');
        }
        return body.event_ids as string[];
    }
}

function networkCode(err: unknown): string {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'TIMEOUT';
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
    return typeof cause?.code === 'string' ? cause.code : 'NETWORK_ERROR';
}
