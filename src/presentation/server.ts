import { performance } from 'perf_hooks';
import { diagnosticContext, diagnosticId, diagnostics } from '../infrastructure/diagnostics';
import express from 'express';
import { existsSync } from 'fs';
import path from 'path';
import type { Server } from 'http';
import { useContainer, useExpressServer } from 'routing-controllers';
import Container, { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../config';
import type { Logger } from '../infrastructure/logger';
import { CONFIG, LOGGER } from '../tokens';
import { AuthController, CaptureController, DiagnosticsController, DicomPreviewController, HealthController, ScreeningController, SystemController, WorklistController } from './controllers';
import { ResponseEnvelopeInterceptor } from './response.interceptor';
import { AuthService } from '../application/services';
import type { UserEntity } from '../infrastructure/database';
import { ErrorHandlerMiddleware } from './middlewares';
import { SetupController } from './controllers/setup.controller';
import { SetupVerificationService } from '../application/services/SetupVerificationService';
import { isLoopback } from '../setup/security';

@Service()
export class GatewayServer {
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
    ) {}

    private authenticate(header: string | undefined): Promise<UserEntity | null> {
        return Container.get(AuthService).authenticate(header);
    }

    start(): Promise<Server> {
        // routing-controllers resolves controllers and middlewares through TypeDI, so
        // they get the same singletons as everything else.
        useContainer(Container);

        const app = express();
        app.disable('x-powered-by');
        app.use((req, res, next) => {
            const start = performance.now();
            const context = { started_ms: start, run_id: diagnosticId(req.headers['x-diagnostic-run-id']), operation_id: diagnosticId(req.headers['x-diagnostic-operation-id']), request_id: diagnosticId(req.headers['x-diagnostic-request-id']) };
            diagnosticContext.run(context, () => {
                let completed = false;
                const finish = (aborted: boolean) => {
                    if (completed) return; completed = true;
                    diagnosticContext.run(context, () => diagnostics.event('http.request', {
                        method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode,
                        bytes: Number(req.headers['content-length']) || 0,
                    }, performance.now() - start, aborted ? 'aborted' : 'ok'));
                };
                res.on('finish', () => finish(false)); res.on('close', () => finish(!res.writableFinished));
                next();
            });
        });
        app.use(express.json({ limit: '1mb' }));
        if (process.env.GATEWAY_SETUP_TOKEN) {
            const verification = Container.get(SetupVerificationService);
            app.use((req, res, next) => {
                res.on('finish', () => {
                    if (res.statusCode !== 200 || isLoopback(req.socket.remoteAddress)) return;
                    const kind = req.method === 'POST' && req.path === '/signin' ? 'phone_signin_at' :
                        req.method === 'GET' && req.path.replace(/\/$/, '') === '/worklist' ? 'worklist_at' : null;
                    if (kind) void verification.observe(kind).catch(() => this.logger.warn('Could not record setup check.'));
                });
                next();
            });
        }

        const ui = path.join(__dirname, 'ui');
        if (existsSync(path.join(ui, 'index.html'))) {
            app.get('/ui', (_req, res) => res.sendFile(path.join(ui, 'index.html')));
            app.use('/ui', express.static(ui, { index: 'index.html', fallthrough: true, redirect: false }));
        } else {
            this.logger.warn(`ui directory not found at ${ui}; /ui is disabled. Run npm run build to copy it.`);
        }

        useExpressServer(app, {
            controllers: [SetupController, AuthController, HealthController, SystemController, WorklistController, CaptureController, DiagnosticsController, DicomPreviewController, ScreeningController],
            middlewares: [ErrorHandlerMiddleware],
            interceptors: [ResponseEnvelopeInterceptor],

            // @Authorized() routes resolve through here. Rejecting returns 401 without
            // the handler ever running.
            authorizationChecker: async (action) => {
                const user = await this.authenticate(action.request.headers.authorization);
                action.request.user = user ?? undefined;
                return user !== null;
            },
            // Supplies @CurrentUser() — which is how a capture records who took it.
            currentUserChecker: async (action) => {
                if (action.request.user) return action.request.user as UserEntity;
                return (await this.authenticate(action.request.headers.authorization)) ?? undefined;
            },
            // Our middleware owns the response shape; the built-in handler would leak
            // stack traces and the rejected payload.
            defaultErrorHandler: false,
            validation: {
                whitelist: true,
                forbidNonWhitelisted: true,
                // Do not echo the rejected value back. On this service a failing field
                // is a patient name or MRN, and it would otherwise land in the HTTP
                // response and every log line that records it.
                validationError: { target: false, value: false },
            },
        });

        // routing-controllers lets unmatched routes fall through to express, whose
        // default 404 is an HTML page. Every client here parses JSON.
        //
        // The headersSent guard matters: routing-controllers continues the chain after
        // its error middleware responds, so without it every handled error is followed
        // by a second write and an ERR_HTTP_HEADERS_SENT in the log.
        app.use((_req, res, next) => {
            if (res.headersSent) {
                next();
                return;
            }
            res.status(404).json({ error: 'not found' });
        });

        return new Promise<Server>((resolve, reject) => {
            // Bound to all interfaces: the Android app reaches this box over the
            // hospital LAN, so localhost-only would make it unreachable.
            const server = app.listen(this.config.listen_port, () => {
                this.logger.info(
                    `gateway listening on port ${this.config.listen_port} (centre ${this.config.centre_code})`
                );
                resolve(server);
            });
            server.on('error', reject);
        });
    }
}
