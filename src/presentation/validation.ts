import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BadRequestError } from 'routing-controllers';

interface Constructor<T> {
    new (): T;
}

// routing-controllers validates @Body() automatically, but a multipart request carries
// structured fields as JSON strings — the form encoding has no notion of a nested
// object. These are parsed back before validation so a multipart endpoint rejects bad
// input exactly like a JSON one does, rather than reporting "must be an object" for a
// payload that was perfectly well formed.
export function parseMultipartDto<T extends object>(
    cls: Constructor<T>,
    body: Record<string, unknown> | undefined,
    jsonFields: string[] = [],
): T {
    const plain: Record<string, unknown> = { ...(body ?? {}) };

    for (const field of jsonFields) {
        const value = plain[field];
        if (typeof value !== 'string') continue;
        try {
            plain[field] = JSON.parse(value);
        } catch {
            throw new BadRequestError(`${field} is not valid JSON`);
        }
    }

    const instance = plainToInstance(cls, plain, { exposeDefaultValues: true });
    const errors = validateSync(instance as object, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        // Never echo the rejected value: on this service it is a patient name or an MRN.
        validationError: { target: false, value: false },
    });

    if (errors.length > 0) {
        const error = new BadRequestError('request failed validation');
        (error as BadRequestError & { errors?: unknown }).errors = errors;
        throw error;
    }

    return instance;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(value: string, what: string): string {
    if (!UUID.test(value)) throw new BadRequestError(`${what} must be a UUID`);
    return value.toLowerCase();
}
