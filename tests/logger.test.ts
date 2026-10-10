import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../src/infrastructure/logger';
import { safeErrorDetail } from '../src/setup/safe-error';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-log-test-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function eventually(read: () => Promise<string>, expected: RegExp): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const text = await read().catch(() => '');
        if (expected.test(text)) return text;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`log file never contained ${expected}`);
}

test('a configured log directory keeps a durable copy of each line in its own file', async () => {
    const logger = createLogger({ directory: path.join(directory, 'logs'), fileName: 'launcher.log' });
    logger.warn('Gateway stopped with exit code 1 and signal none.');
    const text = await eventually(() => fs.readFile(path.join(directory, 'logs', 'launcher.log'), 'utf8'), /exit code 1/);
    expect(text).toMatch(/warn: Gateway stopped/);
    logger.close();
});

test('without a log directory the logger writes to the console only', async () => {
    const prior = process.env.GATEWAY_LOG_DIR;
    delete process.env.GATEWAY_LOG_DIR;
    try {
        const logger = createLogger();
        expect(logger.transports.filter(transport => transport.constructor.name === 'File')).toHaveLength(0);
        logger.close();
    } finally { if (prior !== undefined) process.env.GATEWAY_LOG_DIR = prior; }
});

test('startup failures describe the cause without dumping paths or argv', () => {
    const missing = Object.assign(new Error('spawn /private/secret/path ENOENT -aec PATIENT'), { code: 'ENOENT' });
    expect(safeErrorDetail(missing)).toBe('Error: code ENOENT');
    expect(safeErrorDetail(new Error('Gateway config is invalid:\nport must be a number'))).toBe('Error: Gateway config is invalid: port must be a number');
    expect(safeErrorDetail(new TypeError('Cannot read properties of undefined (reading /patient/name)'))).toBe('TypeError');
    expect(safeErrorDetail('plain string')).toBe('unexpected error');
});
