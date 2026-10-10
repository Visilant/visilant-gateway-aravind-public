// Describes a startup or setup failure for the log and the console without leaking data.
//
// Plain Error instances thrown by this codebase carry operator-safe sentences (config
// validation names fields, never values). Anything with a `code`, and every TypeError,
// may carry a path, argv or a patient field from a library, so only its name and code
// are kept. Errors are never serialised with their stack or their message in those cases.
export function safeErrorDetail(error: unknown): string {
    if (!(error instanceof Error)) return 'unexpected error';
    const code = (error as { code?: unknown }).code;
    const parts = [error.name];
    if (typeof code === 'string' || typeof code === 'number') parts.push(`code ${code}`);
    if (!('code' in error) && !(error instanceof TypeError)) {
        parts.push(error.message.replace(/[\r\n]+/g, ' ').slice(0, 300));
    }
    return parts.join(': ');
}

// The operator-facing sentence for a setup failure that is already safe to show.
export function safeErrorMessage(error: unknown): string | undefined {
    if (!(error instanceof Error) || 'code' in error || error instanceof TypeError) return undefined;
    return error.message;
}
