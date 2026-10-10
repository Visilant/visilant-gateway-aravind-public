import express from 'express';
import path from 'path';
import type { Server } from 'http';
import { randomBytes } from 'crypto';
import { SetupService } from './SetupService';
import { localRequest } from './security';
import { safeErrorMessage } from './safe-error';

export async function startSetupServer(service: SetupService, port = 8081): Promise<Server> {
    const app = express();
    const token = randomBytes(32).toString('hex');
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        const actualPort = (req.socket.address() as { port: number }).port;
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        if (!localRequest(req, actualPort)) { res.status(403).json({ error: 'Open setup on this computer using 127.0.0.1.' }); return; }
        if (req.method !== 'GET' && (req.headers['x-setup-token'] !== token || !req.is('application/json'))) {
            res.status(403).json({ error: 'Reload setup before continuing.' }); return;
        }
        next();
    });
    app.use(express.json({ limit: '32kb' }));
    const route = (fn: (req: express.Request) => Promise<unknown>) => (req: express.Request, res: express.Response) => {
        void fn(req).then(result => res.json(result ?? { ok: true })).catch(error => {
            // Known setup errors are operator-safe; filesystem/network errors must not
            // expose paths, input values or a raw subprocess command.
            const detail = safeErrorMessage(error) ??
                'The gateway could not finish this step. Check storage, permissions and connections, then retry.';
            // Names the setup items still missing from a completion attempt, so the operator
            // sees exactly what to do rather than a generic failure.
            const missing = (error as { missing?: unknown } | null)?.missing;
            res.status(400).json(Array.isArray(missing) ? { error: detail, missing } : { error: detail });
        });
    };
    app.get('/api/session', (_req, res) => res.json({ token }));
    app.get('/api/status', route(() => service.status()));
    app.post('/api/draft', route(req => service.saveDraft(req.body)));
    app.post('/api/computer', route(() => service.computerChecks()));
    app.post('/api/connections', route(() => service.connectionChecks()));
    app.post('/api/activate', route(req => service.activate(req.body)));
    app.post('/api/finish', route(req => service.finish(req.body)));
    app.get('/api/support', (_req, res) => {
        void service.support().then(report => res.type('json').attachment('gateway-setup-support.json').send(JSON.stringify(report, null, 2)))
            .catch(() => res.status(503).json({ error: 'The support report is temporarily unavailable.' }));
    });
    const ui = path.join(__dirname, '../presentation/ui');
    app.get('/', (_req, res) => res.sendFile(path.join(ui, 'setup/index.html')));
    app.use('/assets', express.static(ui, { index: false }));
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        void err; res.status(400).json({ error: 'The request could not be read. Reload setup and retry.' });
    });
    return new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1', () => resolve(server));
        server.once('error', reject);
    });
}
