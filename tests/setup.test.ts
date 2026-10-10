import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { request, Server } from 'http';
import type { AddressInfo } from 'net';
import bcrypt from 'bcryptjs';
import { SetupService, defaultConfig, setupConfig } from '../src/setup/SetupService';
import { startSetupServer } from '../src/setup/server';
import { createLogger } from '../src/infrastructure/logger';
import { createDatabase, UserEntity, CaptureEntity, CaptureStatus } from '../src/infrastructure/database';
import { SetupVerificationService } from '../src/application/services/SetupVerificationService';
import { SetupRepository } from '../src/infrastructure/database/repositories/SetupRepository';
import { SetupController, requireSetupBridge } from '../src/presentation/controllers/setup.controller';
import { SetupIncompleteError, SetupAttestations } from '../src/application/services/SetupVerificationService';
import { SetupBlockedError, MISSING_LABELS, describeEchoFailure } from '../src/setup/SetupService';
import { DicomClient } from '../src/infrastructure/dicom';
import { UnauthorizedError } from 'routing-controllers';
import http from 'http';
import { isLoopback, localRequest } from '../src/setup/security';
import { loadConfig, GatewayConfig } from '../src/config';

let directory: string;
const logger = createLogger(); logger.silent = true;
const config = () => ({ ...defaultConfig(directory), centre_code: 'SYNTHETIC', study_uid_root: '1.2.826.0.1.3680043.10',
    mwl: { host: '127.0.0.1', port: 11112, called_ae: 'WORKLIST', calling_ae: 'VISILANT', requested_procedure_id: 'TEST' },
    store: { host: '127.0.0.1', port: 11112, called_ae: 'PACS', calling_ae: 'VISILANT' } });
const allConfirmed: SetupAttestations = { synthetic: true, viewer: true, startup: true };
const account = { email: 'synthetic@example.org', username: 'test.operator', password: 'test-password-only' };
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-setup-test-')); });
afterEach(async () => { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
function service() {
    const start = jest.fn(); const setup = new SetupService(directory, logger, start, 'bridge-test-token');
    jest.spyOn(setup, 'computerChecks').mockResolvedValue([{ name: 'Tools', ok: true, detail: 'Available' }]);
    jest.spyOn(setup, 'connectionChecks').mockResolvedValue([{ name: 'DICOM', ok: true, detail: 'Connected' }]);
    return { setup, start };
}

test('safe defaults need hospital details and imported paths cannot relocate queued data', () => {
    const defaults = defaultConfig(directory);
    expect(defaults).toMatchObject({ centre_code: 'ARAVIND', listen_port: 8080, retention: 'KEEP', retention_keep_count: 10 });
    expect(() => setupConfig(defaults, directory)).toThrow();
    expect(setupConfig({ ...config(), database_path: 'C:\\other\\state.db', storage_root: 'C:\\other' }, directory).database_path).toBe(path.join(directory, 'gateway.db'));
    expect(() => setupConfig({ ...config(), listen_port: 8081 }, directory)).toThrow(/reserved/);
    expect(() => setupConfig({ ...config(), bogus: 'patient-secret' }, directory)).toThrow(/bogus/);
    expect(() => setupConfig({ ...config(), study_uid_root: 'not-a-uid' }, directory)).toThrow(/UID/);
    const { requested_procedure_id: _omitted, ...unfiltered } = config().mwl;
    expect(setupConfig({ ...config(), mwl: unfiltered }, directory).mwl.requested_procedure_id).toBeUndefined();
    expect(() => setupConfig({ ...config(), mwl: { ...unfiltered, requested_procedure_id: 'REPLACE_ME' } }, directory)).toThrow(/procedure ID/);
});

test('saved draft survives restart, activation hashes password and never overwrites configured state', async () => {
    const first = service(); await first.setup.initialize(); await first.setup.saveDraft(config());
    const second = service(); await second.setup.initialize();
    expect((await second.setup.status()).config.centre_code).toBe('SYNTHETIC');
    await second.setup.activate(account);
    expect(second.start).toHaveBeenCalledTimes(1);
    const saved = loadConfig(second.setup.configPath);
    const db = await createDatabase(saved, logger);
    try {
        const user = await db.getRepository(UserEntity).findOneByOrFail({ email: account.email });
        expect(await bcrypt.compare(account.password, user.password)).toBe(true);
        expect(user.role).toBe('ADMIN');
    } finally { await db.destroy(); }
    expect(await fs.readFile(second.setup.statePath, 'utf8')).not.toContain(account.password);
    expect(await fs.readFile(second.setup.configPath, 'utf8')).not.toContain(account.email);
    await expect(second.setup.activate({ ...account, password: 'replacement-secret' })).rejects.toThrow(/already saved/);
    await expect(second.setup.saveDraft({ ...config(), centre_code: 'REPLACED' })).rejects.toThrow(/already saved/);
    const third = service(); await third.setup.initialize(); expect(third.start).toHaveBeenCalledTimes(1);
    expect(loadConfig(third.setup.configPath).centre_code).toBe('SYNTHETIC');
});

test('failed probes do not publish config or create accounts', async () => {
    const { setup, start } = service(); await setup.initialize(); await setup.saveDraft(config());
    jest.mocked(setup.connectionChecks).mockResolvedValue([{name:'PACS',ok:false,detail:'Unavailable'}]);
    await expect(setup.activate(account)).rejects.toThrow(/checks/);
    await expect(fs.access(setup.configPath)).rejects.toThrow();
    await expect(fs.access(path.join(directory,'gateway.db'))).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
});

test('power loss after committing account can resume only with the original credentials', async () => {
    const first = service(); await first.setup.initialize(); await first.setup.saveDraft(config());
    jest.spyOn(fs, 'link').mockRejectedValueOnce(new Error('Interrupted publication'));
    await expect(first.setup.activate(account)).rejects.toThrow(/Interrupted/);
    expect(first.start).not.toHaveBeenCalled();
    const second = service(); await second.setup.initialize();
    await expect(second.setup.activate({...account,password:'different-password'})).rejects.toThrow(/same setup account/);
    await second.setup.activate(account);
    const db = await createDatabase(loadConfig(second.setup.configPath), logger);
    try { expect(await db.getRepository(UserEntity).count()).toBe(1); } finally { await db.destroy(); }
});

test('local setup rejects DNS rebinding, cross-origin mutations and missing session tokens', async () => {
    const { setup } = service(); await setup.initialize();
    const server: Server = await startSetupServer(setup, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        const page = await fetch(base); expect(page.status).toBe(200); expect(await page.text()).toContain('InSight-Gateway');
        expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(await new Promise<number | undefined>((resolve, reject) => { const req = request(base+'/api/session', { headers: { Host:'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); })).toBe(403);
        expect((await fetch(base+'/api/session', {headers:{Origin:'https://attacker.example'}})).status).toBe(403);
        expect((await fetch(base+'/api/session', {headers:{'sec-fetch-site':'cross-site'}})).status).toBe(403);
        expect((await fetch(base+'/api/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(config())})).status).toBe(403);
        const {token} = await (await fetch(base+'/api/session')).json() as {token:string};
        const headers = {'content-type':'application/json','x-setup-token':token};
        expect((await fetch(base+'/api/draft',{method:'POST',headers,body:JSON.stringify(config())})).status).toBe(200);
        const report = await (await fetch(base+'/api/support')).text();
        expect(report).not.toMatch(/password|WORKLIST|study_uid_root|gateway.db/);
        const malformed = await fetch(base+'/api/draft',{method:'POST',headers,body:'invalid-patient-secret'});
        expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain('patient-secret');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('local request checks never trust forwarded client addresses', () => {
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(localRequest({socket:{remoteAddress:'192.168.1.20'},headers:{host:'127.0.0.1:8081','x-forwarded-for':'127.0.0.1'}} as never,8081)).toBe(false);
});

test('completion requires new delivered captures plus phone/worklist evidence and preserves queue state', async () => {
    const db = await createDatabase(setupConfig(config(),directory),logger);
    try {
        const verification = new SetupVerificationService(new SetupRepository(db));
        const captures = db.getRepository(CaptureEntity);
        const make = (id:string,status:CaptureStatus,time:string) => ({id,status,created_at:time,dicom_path:id+'.dcm',study_instance_uid:'1.2.3',series_instance_uid:'1.2.3.4',sop_instance_uid:'1.2.3.'+id,accession_number:'synthetic'});
        await captures.insert(make('1',CaptureStatus.SENT,'2000-01-01T00:00:00.000Z'));
        await verification.begin();
        await expect(verification.complete(allConfirmed)).rejects.toThrow();
        await Promise.all([verification.observe('phone_signin_at'),verification.observe('worklist_at')]);
        expect(await verification.report()).toMatchObject({received:0,sent:0});
        await captures.insert(make('2',CaptureStatus.PENDING,new Date(Date.now()+1000).toISOString()));
        await expect(verification.complete(allConfirmed)).rejects.toThrow();
        await captures.update('2',{status:CaptureStatus.SENT});
        await verification.complete(allConfirmed);
        const restored = new SetupVerificationService(new SetupRepository(db));
        expect(await restored.report()).toMatchObject({received:1,sent:1,waiting:0,failed:0,completed_at:expect.any(String)});
        expect(await captures.count()).toBe(2);
        expect((await captures.findOneByOrFail({id:'2'})).status).toBe(CaptureStatus.SENT);
    } finally { await db.destroy(); }
});

test('private gateway bridge denies LAN clients, disabled token and unconfirmed completion', async () => {
    const prior = process.env.GATEWAY_SETUP_TOKEN;
    try {
        delete process.env.GATEWAY_SETUP_TOKEN;
        const next = jest.fn();
        requireSetupBridge({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-setup-token': 'test' } } as never, {} as never, next);
        expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);

        process.env.GATEWAY_SETUP_TOKEN = 'test';
        const lan = jest.fn();
        requireSetupBridge({ socket: { remoteAddress: '192.168.1.5' }, headers: { 'x-setup-token': 'test' } } as never, {} as never, lan);
        expect(lan.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);

        const local = jest.fn();
        requireSetupBridge({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-setup-token': 'wrong' } } as never, {} as never, local);
        expect(local.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);

        const allowed = jest.fn();
        requireSetupBridge({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-setup-token': 'test' } } as never, {} as never, allowed);
        expect(allowed).toHaveBeenCalledWith();

        const verification = { report: jest.fn(), complete: jest.fn().mockRejectedValue(new SetupIncompleteError(['startup_confirmation'])) };
        const controller = new SetupController(verification as never);
        await expect(controller.complete({ synthetic: true, viewer: true, startup: false })).rejects.toMatchObject({ missing: ['startup_confirmation'] });
        expect(verification.complete).toHaveBeenCalledWith({ synthetic: true, viewer: true, startup: false });
    } finally { if (prior === undefined) delete process.env.GATEWAY_SETUP_TOKEN; else process.env.GATEWAY_SETUP_TOKEN = prior; }
});

test('a damaged setup progress file does not stop a configured gateway from starting', async () => {
    const first = service(); await first.setup.initialize(); await first.setup.saveDraft(config()); await first.setup.activate(account);
    await fs.writeFile(first.setup.statePath, '{"draft": ');
    const warn = jest.spyOn(logger, 'warn');
    const second = service(); await second.setup.initialize();
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(loadConfig(second.setup.configPath).centre_code).toBe('SYNTHETIC');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Setup progress file could not be read/));
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).not.toMatch(/\{"draft"/);
});

test('connection failures map to distinct operator messages without raw DICOM output', async () => {
    const setup = new SetupService(directory, logger, jest.fn(), 'bridge-test-token');
    await setup.initialize(); await setup.saveDraft(config());
    const echo = jest.spyOn(DicomClient.prototype, 'echo')
        .mockRejectedValueOnce(new Error('DICOM C-ECHO failed: E: Cannot connect: Connection refused /opt/dcmtk/bin/echoscu 127.0.0.1 11112'))
        .mockRejectedValueOnce(new Error('DICOM C-ECHO failed: E: Association Rejected: Called Application Entity Title not recognized -aec PACS'));
    const checks = await setup.connectionChecks();
    expect(echo).toHaveBeenCalledTimes(2);
    expect(checks[0]).toMatchObject({ name: 'Worklist server', ok: false, detail: 'cannot reach 127.0.0.1:11112, check address and firewall' });
    expect(checks[1]).toMatchObject({ name: 'PACS server', ok: false });
    expect(checks[1].detail).toMatch(/^PACS refused the AE title\./);
    expect(JSON.stringify(checks)).not.toMatch(/echoscu|C-ECHO|Association|-aec|dcmtk/);
    expect(describeEchoFailure(new Error('DICOM C-ECHO failed: timed out after 30s.'), 'PACS server', config().store))
        .toBe('cannot reach 127.0.0.1:11112, check address and firewall');
});

// Captured from real echoscu (DCMTK, macOS) against the Docker PACS and a closed port,
// plus the Windows socket wording for the same failures.
test.each([
    ['F: Association Request Failed: 0006:031c TCP Initialization Error: Connection refused', 'reach'],
    ['F: Association Request Failed: 0006:0320 Attempt to connect to unknown host: no-such-host.invalid', 'reach'],
    ['F: Association Request Failed: 0006:031c TCP Initialization Error: No connection could be made because the target machine actively refused it.', 'reach'],
    ['F: Association Request Failed: 0006:031c TCP Initialization Error: No such host is known.', 'reach'],
    ['F: Association Rejected:\nF: Result: Rejected Permanent, Source: Service User\nF: Reason: Called AE Title Not Recognized', 'ae'],
])('real echoscu failure %#: %s', (stderr, kind) => {
    const detail = describeEchoFailure(new Error(`DICOM C-ECHO failed: ${stderr}`), 'Worklist server', config().mwl);
    expect(detail).toEqual(kind === 'reach' ? 'cannot reach 127.0.0.1:11112, check address and firewall' : expect.stringMatching(/^Worklist server refused the AE title\./));
});

test('a refused completion names exactly what is missing instead of blaming every check', async () => {
    const http404 = http.createServer((_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'The test is not complete.', missing: ['startup_confirmation'] }));
    });
    await new Promise<void>(resolve => http404.listen(0, '127.0.0.1', () => resolve()));
    try {
        const { setup } = service(); await setup.initialize(); await setup.saveDraft(config());
        (setup as unknown as { config: GatewayConfig }).config = { ...config(), listen_port: (http404.address() as AddressInfo).port } as GatewayConfig;
        const failure = await setup.bridge('/complete', { synthetic: true, viewer: true, startup: false }).then(() => null, (error: unknown) => error as Error);
        if (!failure) throw new Error('expected the bridge to refuse the incomplete test');
        expect(failure).toBeInstanceOf(SetupBlockedError);
        expect(failure.message).toContain(MISSING_LABELS.startup_confirmation);
        expect(failure.message).not.toMatch(/sign-in|worklist|PACS/i);
    } finally { await new Promise<void>(resolve => http404.close(() => resolve())); }
});
