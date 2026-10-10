import type { Request } from 'express';

export function isLoopback(address: string | undefined): boolean {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// Neither forwarded headers nor a caller-supplied hostname establishes local access.
export function localRequest(req: Request, port: number): boolean {
    return isLoopback(req.socket.remoteAddress) && req.headers.host === `127.0.0.1:${port}` &&
        (!req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}`) &&
        (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])));
}
