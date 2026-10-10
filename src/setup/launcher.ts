import 'reflect-metadata';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { SetupService } from './SetupService';
import { startSetupServer } from './server';
import { createLogger, Logger } from '../infrastructure/logger';
import { safeErrorDetail } from './safe-error';

const RETRY_MS = 5000;

function setupDirectory(): string {
    return path.resolve(process.env.GATEWAY_SETUP_DIR ?? (process.platform === 'win32'
        ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Visilant') : 'data/setup'));
}

// Operator-facing explanation for the most common launcher failures. Anything else keeps
// its safe detail (name, code, validation sentence) and points at the log file.
function explain(error: unknown): string {
    if ((error as { code?: unknown })?.code === 'EADDRINUSE') {
        return 'Port 8081 is already in use. Another gateway setup window or launcher may be running; close it and retry.';
    }
    return `Gateway setup could not start: ${safeErrorDetail(error)}.`;
}

async function main(directory: string, logger: Logger) {
    const logDirectory = path.join(directory, 'logs');
    const token = randomBytes(32).toString('hex');
    let child: ChildProcess | undefined, retry: NodeJS.Timeout | undefined;
    let stopping = false;
    const service = new SetupService(directory, logger, () => {
        const launch = () => {
            if (stopping) return;
            child = spawn(process.execPath, [path.join(__dirname, '../index.js')], {
                stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
                env: { ...process.env, GATEWAY_CONFIG: service.configPath, GATEWAY_SETUP_TOKEN: token, GATEWAY_LOG_DIR: logDirectory },
            });
            const scheduleRetry = () => {
                if (stopping || retry) return;
                retry = setTimeout(() => { retry = undefined; launch(); }, RETRY_MS);
            };
            child.once('error', error => {
                logger.error(`Gateway could not start: ${safeErrorDetail(error)}. Check the installed runtime. Retrying in five seconds.`);
                scheduleRetry();
            });
            child.once('exit', (code, signal) => {
                child = undefined;
                if (stopping) return;
                logger.warn(`Gateway stopped with exit code ${code ?? 'none'} and signal ${signal ?? 'none'}. Retrying in five seconds. Details are in the logs folder.`);
                scheduleRetry();
            });
        };
        launch();
    }, token);
    // Own the local port before touching state or starting a worker. A second launcher
    // cannot run migrations or start a competing queue worker.
    const server = await startSetupServer(service);
    try { await service.initialize(); } catch (error) { server.close(); throw error; }
    logger.info('Open gateway setup on this computer: http://127.0.0.1:8081');
    const stop = () => {
        stopping = true; if (retry) clearTimeout(retry);
        server.close();
        if (child) { child.once('exit', () => process.exit(0)); child.kill('SIGTERM'); }
        else process.exit(0);
        setTimeout(() => process.exit(0), 6000).unref();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

// The launcher writes its own file. The gateway child writes gateway.log in the same
// folder, so two processes never rotate one file.
const directory = setupDirectory();
const logger = createLogger({ directory: path.join(directory, 'logs'), fileName: 'launcher.log' });
main(directory, logger).catch(error => {
    const message = explain(error);
    logger.error(message);
    console.error(`${message} Preserve gateway data. Details are in ${path.join(directory, 'logs')}.`);
    process.exitCode = 1;
});
