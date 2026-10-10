import { mkdirSync } from 'fs';
import path from 'path';
import winston from 'winston';

// Bounded so an unattended box cannot fill its disk: five files of 5 MB each. Winston
// rotates the oldest file out when the current one reaches the size limit.
const LOG_FILE_BYTES = 5 * 1024 * 1024;
const LOG_FILE_COUNT = 5;

export interface LoggerOptions {
    // Defaults to GATEWAY_LOG_DIR. When unset, the logger writes to the console only.
    directory?: string;
    // Each process needs its own file. Two processes rotating one file would corrupt it.
    fileName?: string;
}

// Console output is always kept: the service host captures stdout. When a directory is
// configured (the Windows launcher sets it), the same lines are also written to a rotating
// file, because a Windows task that captures no stdout otherwise loses every log line.
// Callers must log only safe detail: never PHI and never err.message from execFile.
export function createLogger(options: LoggerOptions = {}): winston.Logger {
    const format = winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
    );
    const transports: winston.transport[] = [new winston.transports.Console()];
    const directory = options.directory ?? process.env.GATEWAY_LOG_DIR;
    if (directory) {
        const resolved = path.resolve(directory);
        try {
            mkdirSync(resolved, { recursive: true, mode: 0o700 });
            const file = new winston.transports.File({
                dirname: resolved,
                filename: options.fileName ?? 'gateway.log',
                maxsize: LOG_FILE_BYTES,
                maxFiles: LOG_FILE_COUNT,
                tailable: true,
            });
            // A full or read-only disk must not take the process down with an unhandled
            // transport error. The console line still carries the detail.
            file.on('error', () => { console.error('Gateway log file could not be written. Check the logs folder permissions and free space.'); });
            transports.push(file);
        } catch {
            console.error('Gateway log folder could not be created. Check the data folder permissions.');
        }
    }
    return winston.createLogger({
        level: process.env.LOG_LEVEL ?? 'info',
        format,
        transports,
    });
}

export type Logger = winston.Logger;
