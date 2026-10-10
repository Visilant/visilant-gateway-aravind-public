import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { isEmail } from 'class-validator';
import { GatewayConfig, DicomNodeConfig, validateConfig, loadConfig } from '../config';
import { createDatabase, SettingEntity, UserEntity, UserRole } from '../infrastructure/database';
import { DicomClient } from '../infrastructure/dicom';
import { BIN } from '../infrastructure/dicom/dicom.constants';
import type { SetupVerificationService, SetupMissingItem } from '../application/services/SetupVerificationService';
import { ToolMissingError, describeFailure } from '../infrastructure/dicom/DicomClient';
import type { Logger } from '../infrastructure/logger';
import { safeErrorDetail } from './safe-error';

export interface Check { name: string; ok: boolean; detail: string }
export interface SetupState {
    draft?: GatewayConfig;
    activated_at?: string;
    boot_at?: number;
    completed_at?: string;
}
const exec = promisify(execFile);

// Operator wording for each item the completion check can report as missing.
export const MISSING_LABELS: Record<SetupMissingItem, string> = {
    setup_started: 'the setup test has not started',
    phone_signin: 'a phone sign-in',
    worklist: 'a phone worklist refresh',
    pacs_delivery: 'PACS acceptance of the test images (none waiting or need attention)',
    synthetic_confirmation: 'confirmation that the test used only synthetic patient data',
    viewer_confirmation: 'confirmation that the images are visible in the PACS viewer',
    startup_confirmation: 'confirmation that the gateway restarted and started automatically',
};

// A completion attempt the gateway refused, naming what is still open.
export class SetupBlockedError extends Error {
    constructor(readonly missing: SetupMissingItem[]) {
        super(`The test is not complete. Still needed: ${missing.map(item => MISSING_LABELS[item]).join('; ')}.`);
        this.name = 'SetupBlockedError';
    }
}

// Maps a failed C-ECHO to one operator sentence. The raw DCMTK output is only read here,
// to choose the sentence; it is never returned to the browser.
export function describeEchoFailure(error: unknown, name: string, node: DicomNodeConfig): string {
    if (error instanceof ToolMissingError) return 'The DICOM tool is missing. Reinstall the complete Windows bundle.';
    const text = error instanceof Error ? error.message : '';
    // Phrases checked against real echoscu output (DCMTK 3.6, macOS) plus the Windows
    // socket wording: "actively refused it" and "No such host is known".
    if (/connection refused|actively refused|no connection could be made|timed out|timeout|no route|unreachable|could not connect|unable to connect|host not found|unknown host|no such host|name or service not known|nodename nor servname/i.test(text)) {
        return `cannot reach ${node.host}:${node.port}, check address and firewall`;
    }
    if (/association.*(rejected|aborted)|not recognized|title/i.test(text)) {
        return `${name === 'PACS server' ? 'PACS' : 'Worklist server'} refused the AE title. Ask IT to confirm the hospital AE title and allow the gateway calling AE.`;
    }
    return 'Check the server address, port, AE titles and firewall with IT, then retry.';
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        // Flush before publication. An interrupted setup leaves the previous whole file.
        const handle = await fs.open(temporary, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}

export function defaultConfig(directory: string): Partial<GatewayConfig> {
    return { centre_code: 'ARAVIND', listen_port: 8080, storage_root: path.join(directory, 'captures'),
        database_path: path.join(directory, 'gateway.db'), retention: 'KEEP', retention_keep_count: 10,
        study_uid_root: '1.2.826.0.1.3680043.10.1338', sync_interval_seconds: 30, send_immediately: true, max_send_attempts: 20,
        mwl: { host: '', port: 104, called_ae: '', calling_ae: 'VISILANT' },
        store: { host: '', port: 104, called_ae: '', calling_ae: 'VISILANT' } };
}

export function setupConfig(raw: unknown, directory: string): GatewayConfig {
    const config = validateConfig(raw);
    if (config.listen_port > 65535 || config.listen_port === 8081 || config.mwl.port > 65535 || config.store.port > 65535) {
        throw new Error('Choose ports from 1 to 65535; 8081 is reserved for setup.');
    }
    if (!/^[0-2](\.(0|[1-9][0-9]*))+$/.test(config.study_uid_root) || config.study_uid_root.length > 40) {
        throw new Error('Enter the approved numeric DICOM UID root (up to 40 characters).');
    }
    // Optional: many worklists give every order its own procedure ID, and route orders to
    // a device by modality or station instead. Blank means no procedure ID filter.
    if (config.mwl.requested_procedure_id === 'REPLACE_ME') {
        throw new Error('Replace the example procedure ID, or leave it blank to match all procedures.');
    }
    for (const node of [config.mwl, config.store]) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(node.host)) throw new Error('Enter a server hostname or IP address, without a URL or spaces.');
        for (const title of [node.called_ae, node.calling_ae]) {
            if (!/^[\x20-\x7e]+$/.test(title) || title.includes('\\') || !title.trim()) throw new Error('AE titles must be printable text without a backslash.');
        }
    }
    // A prepared site file supplies hospital details, never relocates an installation's
    // durable state. This also prevents an imported file selecting executable paths.
    config.database_path = path.join(directory, 'gateway.db');
    config.storage_root = path.join(directory, 'captures');
    return config;
}

export class SetupService {
    private state: SetupState = {};
    private config?: GatewayConfig;
    private busy = false;
    readonly configPath: string;
    readonly statePath: string;
    constructor(readonly directory: string, private readonly logger: Logger,
        private readonly startGateway: (config: GatewayConfig) => void,
        private readonly gatewayToken: string) {
        this.configPath = path.join(directory, 'config.json');
        this.statePath = path.join(directory, 'setup-state.json');
    }
    async initialize(): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.state = await this.readState();
        try { await fs.access(this.configPath); }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
        this.config = loadConfig(this.configPath);
        this.startGateway(this.config);
    }
    // Setup progress is only a wizard convenience. Once config.json is valid, a damaged
    // progress file must not stop the hospital's gateway from starting. Log the code only.
    private async readState(): Promise<SetupState> {
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SetupState;
            this.logger.warn('Setup progress file is not in the expected format. Setup progress was reset; saved gateway settings are kept.');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
            this.logger.warn(`Setup progress file could not be read (${safeErrorDetail(err)}). Setup progress was reset; saved gateway settings are kept.`);
        }
        return {};
    }
    private async save(): Promise<void> { await atomicJson(this.statePath, this.state); }
    private async exclusive<T>(action: () => Promise<T>): Promise<T> {
        if (this.busy) throw new Error('Another setup step is running. Please wait.');
        this.busy = true;
        try { return await action(); } finally { this.busy = false; }
    }
    private editable(): void {
        if (this.config) throw new Error('Setup is already saved. Existing settings and queued images are protected. Contact your administrator to change connections.');
    }
    async saveDraft(raw: unknown) {
        return this.exclusive(async () => {
            this.editable(); this.state.draft = setupConfig(raw, this.directory); await this.save(); return this.status();
        });
    }
    async computerChecks(config = this.state.draft): Promise<Check[]> {
        const tools = await Promise.all(Object.entries(BIN).map(async ([name, bin]) => {
            try {
                await exec(bin, [name === 'magick' ? '-version' : '--version'], { timeout: 5000, maxBuffer: 64 * 1024 });
                return { name, ok: true, detail: 'Available' };
            } catch { return { name, ok: false, detail: 'Missing or unable to run. Reinstall the complete Windows bundle.' }; }
        }));
        const checks: Check[] = [{ name: 'Gateway runtime', ok: process.versions.node.split('.')[0] === '22', detail: 'Uses the Node 22 runtime included in the Windows bundle.' },
            { name: 'Image and connection tools', ok: tools.every(tool => tool.ok), detail: tools.every(tool => tool.ok) ? 'All required tools are available.' : 'Reinstall the complete bundle. Missing or unable to run: ' + tools.filter(tool => !tool.ok).map(tool => tool.name).join(', ') }];
        if (tools.find(tool => tool.name === 'magick')?.ok) {
            const converts = await this.imageConversionWorks();
            checks.push({ name: 'Image conversion', ok: converts, detail: converts ? 'ImageMagick can read and write JPEG images.' : 'ImageMagick runs but cannot convert a JPEG image. Reinstall the Windows bundle built with the portable ImageMagick.' });
        }
        const probe = path.join(this.directory, `write-check-${randomUUID()}.tmp`);
        try {
            await fs.writeFile(probe, 'check', { flag: 'wx', mode: 0o600 });
            const disk = await fs.statfs(this.directory);
            checks.push({ name: 'Storage', ok: disk.bavail * disk.bsize >= 1024 ** 3, detail: 'Writable storage with at least 1 GB free is required.' });
        } catch { checks.push({ name: 'Storage', ok: false, detail: 'The gateway cannot write to its data folder.' }); }
        finally { await fs.rm(probe, { force: true }).catch(() => undefined); }
        if (!this.config) {
            const port = config?.listen_port ?? 8080;
            const free = await new Promise<boolean>(resolve => {
                const server = net.createServer();
                server.once('error', () => resolve(false));
                server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
            });
            checks.push({ name: 'Gateway port', ok: free, detail: free ? `Port ${port} is available.` : `Port ${port} is in use. Stop the other gateway or choose another port.` });
        }
        return checks;
    }
    // `magick -version` passes even when ImageMagick cannot load its JPEG coder, as an
    // installer build copied without its registry keys does. Convert a real JPEG, the
    // way every rotated capture is converted, through the same temp folder.
    private async imageConversionWorks(): Promise<boolean> {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'visilant-check-'));
        try {
            const sample = path.join(work, 'sample.jpg');
            await exec(BIN.magick, ['logo:', '-resize', '64x64', sample], { timeout: 15000, maxBuffer: 64 * 1024 });
            await exec(BIN.magick, [sample, '-auto-orient', '-interlace', 'none', path.join(work, 'upright.jpg')], { timeout: 15000, maxBuffer: 64 * 1024 });
            return true;
        } catch (err) {
            this.logger.warn(`Image conversion check failed: ${describeFailure(err, BIN.magick, 15000)}`);
            return false;
        } finally { await fs.rm(work, { recursive: true, force: true }).catch(() => undefined); }
    }
    async connectionChecks(): Promise<Check[]> {
        const config = this.config ?? this.state.draft;
        if (!config) throw new Error('Save the hospital details first.');
        return Promise.all(([['Worklist server', config.mwl], ['PACS server', config.store]] as const).map(async ([name, node]) => {
            try { await new DicomClient(this.logger).echo(node); return { name, ok: true, detail: 'DICOM connection accepted. The final screening checks actual worklist and image delivery.' }; }
            catch (error) { return { name, ok: false, detail: describeEchoFailure(error, name, node) }; }
        }));
    }
    async activate(body: { email?: unknown; username?: unknown; password?: unknown }): Promise<void> {
        await this.exclusive(async () => {
            this.editable();
            const config = this.state.draft;
            if (!config) throw new Error('Save the hospital details first.');
            if (typeof body.email !== 'string' || !isEmail(body.email.trim()) || typeof body.username !== 'string' ||
                !/^[a-zA-Z0-9._-]{2,64}$/.test(body.username) || typeof body.password !== 'string' ||
                Array.from(body.password).length < 12 || Buffer.byteLength(body.password, 'utf8') > 72) {
                throw new Error('Use a valid email, a 2–64 character account name (letters, numbers, dot, dash or underscore), and a password of 12–72 bytes.');
            }
            const checks = [...await this.computerChecks(config), ...await this.connectionChecks()];
            if (checks.some(check => !check.ok)) throw new Error('Resolve the computer and connection checks before continuing.');
            const email = body.email.trim().toLowerCase();
            const username = body.username.toLowerCase();
            const password = body.password;
            await fs.mkdir(config.storage_root, { recursive: true, mode: 0o700 });
            const database = await createDatabase(config, this.logger);
            try {
                const users = database.getRepository(UserEntity);
                const existing = await users.findOneBy({ email });
                const marker = await database.getRepository(SettingEntity).findOneBy({ key: 'setup.account' });
                if (await users.count()) {
                    // Retry after a power loss between account commit and config publication.
                    // Never reset an existing password or adopt a populated hospital database.
                    if (!existing || marker?.value !== existing.id || !await bcrypt.compare(password, existing.password)) {
                        throw new Error('Existing accounts were found. Enter the same setup account and password to resume; do not delete gateway data.');
                    }
                } else {
                    const id = randomUUID(), created_at = new Date().toISOString();
                    const hashed = await bcrypt.hash(password, 12);
                    await database.transaction(async manager => {
                        await manager.getRepository(UserEntity).insert({ id, username, email, password: hashed,
                            display_name: username, role: UserRole.ADMIN, active: true, created_at });
                        await manager.getRepository(SettingEntity).insert({ key: 'setup.account', value: id, created_at });
                    });
                }
            } finally { await database.destroy(); }
            this.state.activated_at = new Date().toISOString();
            this.state.boot_at = Date.now() - os.uptime() * 1000;
            await this.save();
            // Exclusive creation prevents accidentally replacing an existing deployment.
            const temporary = `${this.configPath}.${randomUUID()}.tmp`;
            try {
                await atomicJson(temporary, config);
                await fs.link(temporary, this.configPath);
            } finally { await fs.rm(temporary, { force: true }); }
            this.config = config;
            this.startGateway(config);
        });
    }
    async bridge(route: string, body?: unknown): Promise<Awaited<ReturnType<SetupVerificationService['report']>>> {
        if (!this.config) throw new Error('Create the operator account first.');
        const response = await fetch(`http://127.0.0.1:${this.config.listen_port}/setup-progress${route}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json', 'x-setup-token': this.gatewayToken },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            const failure = await response.json().catch(() => ({})) as { missing?: unknown; error?: unknown };
            if (response.status === 400 && Array.isArray(failure.missing) && failure.missing.length) {
                throw new SetupBlockedError(failure.missing as SetupMissingItem[]);
            }
            if (response.status === 400 && typeof failure.error === 'string') throw new Error(failure.error);
            throw new Error(`The gateway did not answer the setup check (HTTP ${response.status}). Restart the gateway and retry.`);
        }
        return (await response.json() as { data: Awaited<ReturnType<SetupVerificationService['report']>> }).data;
    }
    async finish(body: unknown) {
        return this.exclusive(async () => {
            if (process.env.GATEWAY_MANAGED_STARTUP === '1' && !(await this.status()).reboot_observed) throw new Error('Restart this computer and reopen setup to verify automatic startup.');
            await this.bridge('/complete', body);
            this.state.completed_at = new Date().toISOString(); await this.save(); return this.status();
        });
    }
    async status() {
        let progress = null;
        if (this.config) {
            try { progress = await this.bridge('/begin', {}); } catch { /* Starting or recovering; retain saved configuration. */ }
        }
        let health: { running: boolean; worklist: boolean; pacs: boolean; waiting: number; failed: number } | null = null;
        if (this.config) {
            try {
                const response = await fetch(`http://127.0.0.1:${this.config.listen_port}/health`, { signal: AbortSignal.timeout(8000) });
                const report = await response.json() as { database?: { reachable?: boolean }; queue?: { PENDING: number; SENDING: number; FAILED: number }; dicom?: { mwl?: { reachable?: boolean }; store?: { reachable?: boolean } } };
                health = { running: report.database?.reachable === true, worklist: report.dicom?.mwl?.reachable === true,
                    pacs: report.dicom?.store?.reachable === true,
                    waiting: Number(report.queue?.PENDING ?? 0) + Number(report.queue?.SENDING ?? 0), failed: Number(report.queue?.FAILED ?? 0) };
            } catch { /* The child is starting or recovering. */ }
        }
        const config = this.config ?? this.state.draft ?? defaultConfig(this.directory);
        const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal)
            .map(item => `http://${item!.address}:${config.listen_port}`);
        return { configured: !!this.config, completed: !!this.state.completed_at || !!progress?.completed_at,
            config, health, addresses: [...new Set(addresses)], progress,
            managed_startup: process.env.GATEWAY_MANAGED_STARTUP === '1',
            reboot_observed: !!this.state.boot_at && Math.abs(Date.now() - os.uptime() * 1000 - this.state.boot_at) > 60000 };
    }
    async support() {
        const status = await this.status();
        // An explicit allowlist: no environment, credentials, raw errors, addresses,
        // capture identifiers, patient fields, database contents or configuration dump.
        return { format: 1, version: '0.1.0', build: process.env.GATEWAY_BUILD_ID ?? 'development', generated_at: new Date().toISOString(), platform: process.platform,
            node: process.versions.node, configured: status.configured, completed: status.completed,
            managed_startup: status.managed_startup, reboot_observed: status.reboot_observed, progress: status.progress, health: status.health };
    }
}
