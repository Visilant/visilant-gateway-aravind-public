#!/usr/bin/env node
// End-to-end harness: the real gateway, the real DCMTK tools and a real dcm4chee archive,
// exercised over HTTP exactly as the Android app would.
//
//   npm run e2e                  # build, start the local PACS if needed, run everything
//   npm run e2e -- --keep        # leave the temp dirs behind for inspection
//
// Every run seeds its own worklist orders (unique procedure ID, accessions and MRNs) so it
// never collides with earlier runs or with dev/seed-mwl.mjs data in the same archive.
//
// Two gateway instances are started:
//   A  healthy archive, send_immediately on, a 300s sync interval — so anything that
//      reaches the PACS within seconds can only have got there by the immediate send.
//   B  archive unreachable at first, then restarted with the right port — outage,
//      backoff, FAILED + manual retry, power loss mid-send, idempotent re-send.
//
// Needs Docker, DCMTK (findscu, storescu, img2dcm, echoscu, dcm2json, dcmdump, dcmodify) and ImageMagick.

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const Database = require('better-sqlite3');

const KEEP = process.argv.includes('--keep');
const PACS = process.env.PACS_BASE ?? 'http://localhost:8008/dcm4chee-arc';
const QIDO = `${PACS}/aets/DCM4CHEE/rs`;
const DIMSE = { host: 'localhost', port: 11112 };
const DEAD_PORT = 11199;  // nothing listens here: the "archive is down" case

const OP_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.77.1.5.1';
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const PROCEDURE_ID = `ASI${RUN}`;          // SH, <= 16
const OTHER_PROCEDURE_ID = `OTH${RUN}`;
const TODAY = da(new Date());
const PASSWORD = 'e2e-Passw0rd!';
const EMAIL = 'e2e@visilant.test';

const work = mkdtempSync(path.join(tmpdir(), 'visilant-e2e-'));
const children = new Set();

// ── tiny test runner ────────────────────────────────────────────────────────────────

const results = [];
let section = '';

async function step(name, fn) {
    const label = section ? `${section} › ${name}` : name;
    const started = Date.now();
    try {
        await fn();
        results.push({ label, ok: true });
        console.log(`  \x1b[32m✓\x1b[0m ${label} \x1b[2m(${Date.now() - started}ms)\x1b[0m`);
    } catch (err) {
        results.push({ label, ok: false, error: err });
        console.log(`  \x1b[31m✗ ${label}\x1b[0m\n      ${String(err?.message ?? err).split('\n').join('\n      ')}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function eq(actual, expected, what) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 30_000, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (err) {
            last = err;
        }
        await sleep(intervalMs);
    }
    throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

function da(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

// ── environment ─────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function echo(ae) {
    try {
        run('echoscu', [DIMSE.host, String(DIMSE.port), '-aec', ae, '-aet', 'VISILANT'], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function ensurePacs() {
    if (echo('DCM4CHEE') && echo('WORKLIST')) return;
    console.log('  starting local dcm4chee (first boot takes a minute or two)…');
    run('docker', ['compose', '-f', 'dev/docker-compose.pacs.yml', 'up', '-d'], { stdio: 'inherit' });
    await waitFor('dcm4chee to accept associations', () => echo('DCM4CHEE') && echo('WORKLIST'), 240_000, 3000);
}

function fixtures() {
    const dir = path.join(work, 'fixtures');
    mkdirSync(dir);
    const baseline = path.join(dir, 'baseline.jpg');
    const progressive = path.join(dir, 'progressive.jpg');
    const png = path.join(dir, 'not-a-jpeg.png');
    run('magick', ['-size', '640x480', 'gradient:navy-white', '-interlace', 'none', baseline]);
    run('magick', ['-size', '640x480', 'gradient:darkred-white', '-interlace', 'JPEG', progressive]);
    run('magick', ['-size', '64x64', 'xc:green', png]);
    return {
        baseline: readFileSync(baseline),
        progressive: readFileSync(progressive),
        png: readFileSync(png),
    };
}

// ── worklist seeding (stands in for eyeNotes → MWL server) ────────────────────────────

async function postDicomJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dicom+json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status} ${await res.text()}`);
    return res.json().catch(() => null);
}

async function seedOrder({ accession, mrn, name, dob, sex, procedureId, studyUid, time }) {
    const patient = { '00100020': { vr: 'LO', Value: [mrn] } };
    if (name) patient['00100010'] = { vr: 'PN', Value: [{ Alphabetic: name }] };
    if (dob) patient['00100030'] = { vr: 'DA', Value: [dob] };
    if (sex) patient['00100040'] = { vr: 'CS', Value: [sex] };
    await postDicomJson(`${QIDO}/patients`, patient);

    const item = {
        ...patient,
        '00080050': { vr: 'SH', Value: [accession] },
        '00080090': { vr: 'PN', Value: [{ Alphabetic: 'NATARAJAN^SURESH' }] },
        '00321060': { vr: 'LO', Value: ['Anterior Segment Image'] },
        '00401001': { vr: 'SH', Value: [procedureId] },
        '00400100': {
            vr: 'SQ',
            Value: [{
                '00080060': { vr: 'CS', Value: ['OP'] },
                '00400002': { vr: 'DA', Value: [TODAY] },
                '00400003': { vr: 'TM', Value: [time] },
                '00400007': { vr: 'LO', Value: ['Anterior Segment Image'] },
                '00400009': { vr: 'SH', Value: [`S${accession}`] },
                '00400020': { vr: 'CS', Value: ['SCHEDULED'] },
            }],
        },
    };
    if (studyUid) item['0020000D'] = { vr: 'UI', Value: [studyUid] };
    const created = await postDicomJson(`${PACS}/aets/WORKLIST/rs/mwlitems`, item);
    return created?.['0020000D']?.Value?.[0] ?? studyUid;
}

// ── gateway process control ─────────────────────────────────────────────────────────

class Gateway {
    constructor(name, overrides) {
        this.name = name;
        this.dir = path.join(work, name);
        mkdirSync(this.dir);
        this.port = 18000 + Math.floor(Math.random() * 1000);
        this.logPath = path.join(this.dir, 'gateway.log');
        this.configPath = path.join(this.dir, 'config.json');
        this.config = {
            centre_code: `E2E_${name}`,
            listen_port: this.port,
            storage_root: path.join(this.dir, 'captures'),
            database_path: path.join(this.dir, 'gateway.db'),
            retention: 'DELETE_ON_SENT',
            study_uid_root: '1.2.826.0.1.3680043.10.1338',
            sync_interval_seconds: 300,
            send_immediately: true,
            max_send_attempts: 20,
            mwl: { ...DIMSE, called_ae: 'WORKLIST', calling_ae: 'VISILANT', requested_procedure_id: PROCEDURE_ID },
            store: { ...DIMSE, called_ae: 'DCM4CHEE', calling_ae: 'VISILANT' },
            ...overrides,
        };
        this.writeConfig();
    }

    writeConfig() {
        writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    }

    get url() {
        return `http://127.0.0.1:${this.port}`;
    }

    env() {
        return { ...process.env, GATEWAY_CONFIG: this.configPath };
    }

    addUser() {
        run('node', ['build/src/cli/manage-users.js', 'add', EMAIL, 'e2e', '--password', PASSWORD], { env: this.env() });
    }

    async start() {
        const log = createWriteStream(this.logPath, { flags: 'a' });
        this.proc = spawn('node', ['build/src/index.js'], { cwd: ROOT, env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc.stdout.pipe(log);
        this.proc.stderr.pipe(log);
        children.add(this.proc);
        this.proc.on('exit', () => children.delete(this.proc));
        await waitFor(`gateway ${this.name} to listen`, async () => {
            if (this.proc.exitCode !== null) throw new Error(`exited early:\n${this.log()}`);
            const res = await fetch(`${this.url}/health`);
            return res.status === 200 || res.status === 503;
        }, 30_000, 300);
    }

    async stop() {
        if (!this.proc || this.proc.exitCode !== null) return;
        const exited = new Promise((r) => this.proc.once('exit', r));
        this.proc.kill('SIGTERM');
        await Promise.race([exited, sleep(8000)]);
        if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }

    log() {
        return existsSync(this.logPath) ? readFileSync(this.logPath, 'utf8') : '';
    }

    async request(method, route, { token = this.token, body, form, headers: extraHeaders = {} } = {}) {
        const headers = { ...extraHeaders };
        if (token) headers.Authorization = `Bearer ${token}`;
        let payload;
        if (form) payload = form;
        else if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const res = await fetch(`${this.url}${route}`, { method, headers, body: payload });
        const text = await res.text();
        let json;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status: res.status, json, text };
    }

    async signIn() {
        const res = await this.request('POST', '/signin', { token: null, body: { email: EMAIL, password: PASSWORD } });
        eq(res.status, 200, 'sign-in status');
        this.token = res.json.data.token;
        return this.token;
    }

    async capture(entry, fields = {}, file = FIX.baseline, filename = 'eye.jpg', type = 'image/jpeg') {
        const form = new FormData();
        if (file) form.append('file', new Blob([file], { type }), filename);
        if (entry !== undefined) form.append('worklist_entry', typeof entry === 'string' ? entry : JSON.stringify(entry));
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        return this.request('POST', '/captures', { form });
    }

    async captures() {
        const res = await this.request('GET', '/captures');
        eq(res.status, 200, 'GET /captures status');
        return res.json.data;
    }

    async waitStatus(id, status, timeoutMs = 20_000) {
        return waitFor(`capture ${id} to be ${status}`, async () => {
            const row = (await this.captures()).find((c) => c.id === id);
            if (row?.status === status) return row;
            if (row && status === 'SENT' && row.status === 'FAILED') throw new Error(`FAILED: ${row.last_error}`);
            return null;
        }, timeoutMs, 300);
    }

    db() {
        return new Database(this.config.database_path);
    }
}

// ── PACS verification ───────────────────────────────────────────────────────────────

async function qido(route) {
    const res = await fetch(`${QIDO}${route}`, { headers: { Accept: 'application/dicom+json' } });
    if (res.status === 204) return [];
    if (!res.ok) throw new Error(`QIDO ${route} → HTTP ${res.status}`);
    return res.json();
}

const v = (ds, tag) => ds?.[tag]?.Value?.[0];
const code = (ds, tag) => v(v(ds, tag), '00080100');   // first item's CodeValue
const pn = (ds, tag) => v(ds, tag)?.Alphabetic;

async function instancesOf(studyUid, expected) {
    return waitFor(`${expected} instance(s) in study ${studyUid}`, async () => {
        const meta = await qido(`/studies/${studyUid}/metadata`);
        return meta.length >= expected ? meta : null;
    }, 30_000, 1000);
}

// ── scenarios ───────────────────────────────────────────────────────────────────────

let FIX;

async function main() {
    console.log(`\nvisilant-gateway e2e  run=${RUN}  work=${work}\n`);

    section = 'setup';
    await step('local PACS is up (C-ECHO to DCM4CHEE and WORKLIST)', ensurePacs);
    await step('gateway builds', () => { run('npm', ['run', 'build']); });
    await step('fixtures generated (baseline JPEG, progressive JPEG, PNG)', () => { FIX = fixtures(); });

    const orders = {
        main: { accession: `A${RUN}1`, mrn: `MRN${RUN}1`, name: 'RAMACHANDRAN^LAKSHMI', dob: '19580412', sex: 'F',
            procedureId: PROCEDURE_ID, studyUid: `1.2.826.0.1.3680043.10.1338.99.${Date.now()}.1`, time: '093000' },
        rasUid: { accession: `A${RUN}2`, mrn: `MRN${RUN}2`, name: 'SUBRAMANIAN^ARJUN', dob: '19710903', sex: 'M',
            procedureId: PROCEDURE_ID, time: '100000' },                       // archive assigns the Study UID
        noName: { accession: `A${RUN}3`, mrn: `MRN${RUN}3`, procedureId: PROCEDURE_ID, time: '103000' },
        other: { accession: `A${RUN}4`, mrn: `MRN${RUN}4`, name: 'KRISHNAN^VIJAY', dob: '19830715', sex: 'M',
            procedureId: OTHER_PROCEDURE_ID, time: '110000' },                // a different procedure: filtered out
        outage: { accession: `A${RUN}5`, mrn: `MRN${RUN}5`, name: 'PILLAI^ANJALI', dob: '19920228', sex: 'F',
            procedureId: PROCEDURE_ID, time: '113000' },
        screened: { accession: `A${RUN}6`, mrn: `MRN${RUN}6`, name: 'MENON^KAVYA', dob: '19660611', sex: 'F',
            procedureId: PROCEDURE_ID, time: '120000' },                      // submitted as a registered screening
    };
    await step('worklist orders seeded into the MWL server', async () => {
        for (const order of Object.values(orders)) order.studyUid = await seedOrder(order);
    });
    // PHI the gateway must never write to its database or logs.
    const PHI = Object.values(orders).flatMap((o) => [o.mrn, o.name, o.dob].filter(Boolean))
        .flatMap((s) => (s.includes('^') ? [s, ...s.split('^')] : [s]));

    // ── Gateway A: the normal day ──────────────────────────────────────────────────
    const A = new Gateway('A');
    section = 'A boot';
    await step('operator created with the users CLI', () => A.addUser());
    await step('gateway starts', () => A.start());
    await step('GET /health is 200 with both DICOM nodes reachable', async () => {
        const res = await A.request('GET', '/health', { token: null });
        eq(res.status, 200, `health status (${res.text})`);
        eq(res.json.status, 'ok', 'health.status');
        eq(res.json.dicom.mwl.reachable, true, 'mwl reachable');
        eq(res.json.dicom.store.reachable, true, 'store reachable');
        eq(res.json.database.reachable, true, 'database reachable');
    });

    section = 'A auth';
    await step('worklist without a token is 401', async () => {
        eq((await A.request('GET', '/worklist', { token: null })).status, 401, 'status');
    });
    await step('a garbage token is 401', async () => {
        eq((await A.request('GET', '/worklist', { token: 'not.a.jwt' })).status, 401, 'status');
    });
    await step('wrong password is 401', async () => {
        const res = await A.request('POST', '/signin', { token: null, body: { email: EMAIL, password: 'nope' } });
        eq(res.status, 401, 'status');
    });
    await step('sign-in returns a token and refresh token', async () => {
        const res = await A.request('POST', '/signin', { token: null, body: { email: EMAIL, password: PASSWORD } });
        eq(res.status, 200, 'status');
        assert(res.json.data.token && res.json.data.refresh_token, 'token pair missing');
        A.token = res.json.data.token;
        A.refreshToken = res.json.data.refresh_token;
    });
    await step('refresh issues a working token', async () => {
        const res = await A.request('POST', '/refresh', { token: null, body: { refresh_token: A.refreshToken } });
        eq(res.status, 200, 'status');
        A.token = res.json.data.token;
        eq((await A.request('GET', '/captures')).status, 200, 'refreshed token works');
    });

    section = 'operator page and auth';
    await step('static operator page and assets are public', async () => {
        for (const [route, type] of [['/ui', 'text/html'], ['/ui/', 'text/html'], ['/ui/app.js', 'javascript'], ['/ui/app.css', 'text/css']]) {
            const res = await fetch(A.url + route); eq(res.status, 200, route);
            assert(res.headers.get('content-type').includes(type), `${route}: wrong content-type`);
        }
        eq((await A.request('GET', '/ui/nope.js')).status, 404, 'unknown asset');
    });
    await step('diagnostics and system routes require a token', async () => {
        for (const route of ['/diagnostics', '/system/config', '/system/device']) eq((await A.request('GET', route, { token: null })).status, 401, route);
        const result = await A.request('GET', '/diagnostics'); eq(result.status, 200, 'diagnostics status');
        eq(result.json.data.recording.enabled, false, 'recording off'); eq(result.json.data.recording.locked_by, null, 'toggle unlocked');
    });
    await step('invalid diagnostic and capture IDs are rejected', async () => {
        eq((await A.request('GET', '/diagnostics/segments/..%2Fx')).status, 400, 'invalid segment ID');
        eq((await A.request('GET', '/diagnostics/runs/not-a-uuid')).status, 400, 'invalid run ID');
        eq((await A.request('GET', '/captures/not-a-uuid')).status, 400, 'invalid capture ID');
        eq((await A.request('GET', '/captures/00000000-0000-0000-0000-000000000000')).status, 404, 'unknown capture');
    });
    await step('invalid refresh token returns 401', async () => {
        eq((await A.request('POST', '/refresh', { token: null, body: { refresh_token: 'garbage' } })).status, 401, 'refresh status');
    });

    section = 'A worklist (C-FIND)';
    let worklist = [];
    const entryFor = (order) => worklist.find((e) => e.accession_number === order.accession);
    await step('returns only orders with the configured Requested Procedure ID', async () => {
        const res = await A.request('GET', '/worklist');
        eq(res.status, 200, `status (${res.text})`);
        worklist = res.json.data;
        const accessions = worklist.map((e) => e.accession_number).sort();
        eq(accessions, [orders.main, orders.rasUid, orders.noName, orders.outage, orders.screened].map((o) => o.accession).sort(), 'accessions');
        assert(!entryFor(orders.other), 'an order for another procedure leaked into the worklist');
    });
    await step('entry carries demographics and the RIS Study UID, DICOM-native', async () => {
        const e = entryFor(orders.main);
        eq(e.study_instance_uid, orders.main.studyUid, 'study_instance_uid');
        eq(e.patient_id, orders.main.mrn, 'patient_id');
        eq(e.patient_name, orders.main.name, 'patient_name');
        eq(e.patient_birth_date, orders.main.dob, 'patient_birth_date');
        eq(e.patient_sex, 'F', 'patient_sex');
        eq(e.requested_procedure_id, PROCEDURE_ID, 'requested_procedure_id');
        eq(e.scheduled?.start_date, TODAY, 'scheduled.start_date');
        eq(e.scheduled?.modality, 'OP', 'scheduled.modality');
    });
    await step('archive-assigned Study UID is passed through', async () => {
        assert(orders.rasUid.studyUid, 'seed did not report a UID');
        eq(entryFor(orders.rasUid).study_instance_uid, orders.rasUid.studyUid, 'study_instance_uid');
    });
    await step('order with no patient name is listed, name absent rather than invented', async () => {
        const e = entryFor(orders.noName);
        assert(e, 'nameless order missing');
        assert(!('patient_name' in e), `patient_name should be absent, got ${JSON.stringify(e.patient_name)}`);
    });
    await step('?accession_number narrows to one order', async () => {
        const res = await A.request('GET', `/worklist?accession_number=${orders.main.accession}`);
        eq(res.json.data.map((e) => e.accession_number), [orders.main.accession], 'result');
    });
    await step('?patient_id narrows to that patient', async () => {
        const res = await A.request('GET', `/worklist?patient_id=${orders.rasUid.mrn}`);
        eq(res.json.data.map((e) => e.accession_number), [orders.rasUid.accession], 'result');
    });
    await step('a malformed ?date is a 400', async () => {
        eq((await A.request('GET', '/worklist?date=yesterday')).status, 400, 'status');
    });

    section = 'A capture validation';
    const main = () => entryFor(orders.main);
    const bad = async (name, fn) => step(name, async () => {
        const res = await fn();
        eq(res.status, 400, `status (${res.text})`);
    });
    await bad('missing file → 400', () => A.capture(main(), { laterality: 'R' }, null));
    await bad('PNG instead of JPEG → 400', () => A.capture(main(), { laterality: 'R' }, FIX.png, 'x.png', 'image/png'));
    await bad('JPEG mimetype with PNG bytes → 400', () => A.capture(main(), { laterality: 'R' }, FIX.png, 'x.jpg'));
    await step('oversized upload (> 32 MB) → 413', async () => {
        const res = await A.capture(main(), { laterality: 'R' }, Buffer.alloc(33 * 1024 * 1024, 0xff));
        eq(res.status, 413, `status (${res.text})`);
    });
    await bad('missing laterality → 400', () => A.capture(main(), {}));
    await bad('laterality other than L/R → 400', () => A.capture(main(), { laterality: 'X' }));
    await bad('unknown light mode → 400', () => A.capture(main(), { laterality: 'R', light: 'UV' }));
    await bad('pupil_dilated not YES/NO → 400', () => A.capture(main(), { laterality: 'R', pupil_dilated: 'maybe' }));
    await bad('worklist_entry missing → 400', () => A.capture(undefined, { laterality: 'R' }));
    await bad('worklist_entry not JSON → 400', () => A.capture('{nope', { laterality: 'R' }));
    await bad('worklist_entry without accession → 400', () => {
        const { accession_number: _a, ...rest } = main();
        return A.capture(rest, { laterality: 'R' });
    });
    await bad('unknown form field → 400', () => A.capture(main(), { laterality: 'R', eye: 'right' }));
    await step('validation errors never echo the rejected value', async () => {
        const res = await A.capture({ ...main(), patient_birth_date: 'SECRET^VALUE' }, { laterality: 'R' });
        eq(res.status, 400, 'status');
        assert(!res.text.includes('SECRET'), 'response echoed the rejected value');
    });
    await step('a capture without a token is 401', async () => {
        const form = new FormData();
        form.append('file', new Blob([FIX.baseline], { type: 'image/jpeg' }), 'eye.jpg');
        eq((await A.request('POST', '/captures', { token: null, form })).status, 401, 'status');
    });
    await step('rejected captures queued nothing', async () => {
        eq((await A.captures()).length, 0, 'queue length');
    });

    await step('same Idempotency-Key twice → one row and one PACS instance', async () => {
        const studyUid = `${orders.main.studyUid}.9`;
        const entry = { ...main(), study_instance_uid: studyUid, accession_number: `${orders.main.accession}I` };
        const key = `e2e-${RUN}`;
        const post = () => {
            const form = new FormData();
            form.append('file', new Blob([FIX.baseline], { type: 'image/jpeg' }), 'eye.jpg');
            form.append('worklist_entry', JSON.stringify(entry));
            form.append('laterality', 'R');
            return A.request('POST', '/captures', { form, headers: { 'Idempotency-Key': key } });
        };
        const first = await post();
        eq(first.status, 200, `first status (${first.text})`);
        const repeated = await post();
        eq(repeated.status, 200, `repeat status (${repeated.text})`);
        eq(repeated.json.data.id, first.json.data.id, 'same capture id');
        eq(repeated.json.data.sop_instance_uid, first.json.data.sop_instance_uid, 'same SOP UID');
        const rows = (await A.captures()).filter((capture) => capture.client_capture_id === key);
        eq(rows.length, 1, 'one capture row');
        await A.waitStatus(first.json.data.id, 'SENT', 30_000);
        eq((await instancesOf(studyUid, 1)).length, 1, 'one PACS instance');
    });

    section = 'A capture → PACS';
    const shots = {};
    const created = async (key, entry, fields, file) => {
        const res = await A.capture(entry, fields, file);
        eq(res.status, 200, `${key} status (${res.text})`);
        shots[key] = res.json.data;
        return res.json.data;
    };
    await step('right eye, white light, pupil dilated → accepted', () =>
        created('rWhite1', main(), { laterality: 'R', light: 'WHITE', pupil_dilated: 'YES' }));
    await step('second right/white photo joins the same series', async () => {
        await created('rWhite2', main(), { laterality: 'R', light: 'WHITE' });
        eq(shots.rWhite2.series_instance_uid, shots.rWhite1.series_instance_uid, 'series UID');
        assert(shots.rWhite2.sop_instance_uid !== shots.rWhite1.sop_instance_uid, 'SOP UIDs must differ');
    });
    await step('both eyes photographed at once (concurrent) → both accepted', async () => {
        await Promise.all([
            created('rSlit', main(), { laterality: 'R', light: 'SLIT' }),
            created('lBlue', main(), { laterality: 'L', light: 'BLUE', pupil_dilated: 'NO' }, FIX.progressive),
        ]);
    });
    await step('left eye with no light mode → accepted', () => created('lNone', main(), { laterality: 'L' }));
    await step('archive-assigned-UID order → accepted', () => created('ras', entryFor(orders.rasUid), { laterality: 'R', light: 'WHITE' }));
    await step('nameless order → accepted', () => created('noName', entryFor(orders.noName), { laterality: 'L', light: 'WHITE' }));
    await step('response carries the worklist Study UID', async () => {
        eq(shots.rWhite1.study_instance_uid, orders.main.studyUid, 'study_instance_uid');
        eq(shots.ras.study_instance_uid, orders.rasUid.studyUid, 'study_instance_uid');
    });
    await step('all reach SENT via the immediate send (sync interval is 300s)', async () => {
        for (const shot of Object.values(shots)) await A.waitStatus(shot.id, 'SENT', 20_000);
    });

    let meta = [];
    const bySop = (sop) => meta.find((m) => v(m, '00080018') === sop);
    await step('PACS holds one study for the order with all 5 instances', async () => {
        const studies = await qido(`/studies?AccessionNumber=${orders.main.accession}`);
        eq(studies.length, 1, 'studies for accession');
        eq(v(studies[0], '0020000D'), orders.main.studyUid, 'StudyInstanceUID');
        meta = await instancesOf(orders.main.studyUid, 5);
        eq(meta.length, 5, 'instance count');
    });
    await step('every instance is Ophthalmic Photography 8-bit, Modality OP', async () => {
        for (const m of meta) {
            eq(v(m, '00080016'), OP_SOP_CLASS, 'SOPClassUID');
            eq(v(m, '00080060'), 'OP', 'Modality');
        }
    });
    await step('demographics and order identity match the worklist', async () => {
        for (const m of meta) {
            eq(v(m, '00100020'), orders.main.mrn, 'PatientID');
            eq(pn(m, '00100010'), orders.main.name, 'PatientName');
            eq(v(m, '00100030'), orders.main.dob, 'PatientBirthDate');
            eq(v(m, '00100040'), 'F', 'PatientSex');
            eq(v(m, '00080050'), orders.main.accession, 'AccessionNumber');
            eq(v(m, '00200010'), orders.main.accession, 'StudyID');
            eq(v(m, '00080020'), TODAY, 'StudyDate (from the scheduled step)');
            eq(v(m, '00080030'), orders.main.time, 'StudyTime (from the scheduled step)');
            eq(pn(m, '00080090'), 'NATARAJAN^SURESH', 'ReferringPhysicianName');
        }
    });
    await step('SOP Instance UIDs are the ones the gateway returned', async () => {
        for (const key of ['rWhite1', 'rWhite2', 'rSlit', 'lBlue', 'lNone']) {
            assert(bySop(shots[key].sop_instance_uid), `${key} not found in PACS by SOP UID`);
            eq(v(bySop(shots[key].sop_instance_uid), '0020000E'), shots[key].series_instance_uid, `${key} series UID`);
        }
    });
    await step('laterality, orientation, light codes and pupil per image', async () => {
        const expect = {
            rWhite1: { lat: 'R', ser: 1, ill: 'R-1020E', filt: '111609', pupil: 'YES' },
            rWhite2: { lat: 'R', ser: 1, ill: 'R-1020E', filt: '111609', pupil: undefined },
            rSlit: { lat: 'R', ser: 3, ill: 'R-1020F', filt: '111609', pupil: undefined },
            lBlue: { lat: 'L', ser: 6, ill: 'R-1020E', filt: '111603', pupil: 'NO' },
            lNone: { lat: 'L', ser: 8, ill: undefined, filt: undefined, pupil: undefined },
        };
        for (const [key, x] of Object.entries(expect)) {
            const m = bySop(shots[key].sop_instance_uid);
            eq(v(m, '00200062'), x.lat, `${key} ImageLaterality`);
            eq(m['00200020']?.Value, ['A', x.lat], `${key} PatientOrientation`);
            eq(Number(v(m, '00200011')), x.ser, `${key} SeriesNumber`);
            eq(code(m, '00220016'), x.ill, `${key} illumination code`);
            eq(code(m, '00220017'), x.filt, `${key} light path filter code`);
            eq(v(m, '0022000D'), x.pupil, `${key} PupilDilated`);
            eq(code(m, '00220015'), 'R-1021B', `${key} acquisition device`);
            eq(code(m, '00082218'), '32259006', `${key} anterior segment anatomy`);
        }
    });
    await step('stored anatomy identifies anterior segment imaging with no fundus label', async () => {
        for (const m of meta) {
            const region = m['00082218'].Value;
            eq(region.length, 1, 'one anatomic region');
            eq(v(region[0], '00080102'), 'SCT', 'anatomic coding scheme');
            eq(v(region[0], '00080104'), 'Anterior segment of eye', 'anatomic meaning');
            assert(!/fundus/i.test(JSON.stringify(m)), 'fundus label in stored metadata');
        }
    });
    await step('4 series (R white, R slit, L blue, L unspecified), instances numbered within series', async () => {
        const series = await qido(`/studies/${orders.main.studyUid}/series`);
        eq(series.length, 4, 'series count');
        eq(series.map((s) => Number(v(s, '00200011'))).sort((a, b) => a - b), [1, 3, 6, 8], 'series numbers');
        eq(Number(v(bySop(shots.rWhite1.sop_instance_uid), '00200013')), 1, 'first right/white InstanceNumber');
        eq(Number(v(bySop(shots.rWhite2.sop_instance_uid), '00200013')), 2, 'second right/white InstanceNumber');
    });
    await step('progressive JPEG was re-encoded and stored as JPEG Baseline', async () => {
        const res = await fetch(`${QIDO}/studies/${orders.main.studyUid}/series/${shots.lBlue.series_instance_uid}/instances/${shots.lBlue.sop_instance_uid}`,
            { headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' } });
        eq(res.status, 200, 'WADO status');
        const body = Buffer.from(await res.arrayBuffer());
        assert(body.includes(Buffer.from('1.2.840.10008.1.2.4.50')), 'stored object is not JPEG Baseline (1.2.840.10008.1.2.4.50)');
    });
    await step('archive-assigned-UID order filed under that UID', async () => {
        const [m] = await instancesOf(orders.rasUid.studyUid, 1);
        eq(v(m, '00080050'), orders.rasUid.accession, 'AccessionNumber');
        eq(v(m, '00100020'), orders.rasUid.mrn, 'PatientID');
    });
    await step('nameless order stored with an empty Patient Name, not an invented one', async () => {
        const [m] = await instancesOf(orders.noName.studyUid, 1);
        eq(pn(m, '00100010'), undefined, 'PatientName');
        eq(v(m, '00100030'), undefined, 'PatientBirthDate');
        eq(v(m, '00100040'), undefined, 'PatientSex');
    });
    await step('DELETE_ON_SENT removed every local .dcm', async () => {
        const left = [];
        const walk = (d) => existsSync(d) && readdirSync(d, { withFileTypes: true })
            .forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : left.push(e.name)));
        walk(A.config.storage_root);
        eq(left.filter((f) => f.endsWith('.dcm')), [], 'files left on disk');
    });
    await step('GET /captures?status filters, and rejects an unknown status', async () => {
        const sent = await A.request('GET', '/captures?status=SENT');
        eq(sent.json.data.length, Object.keys(shots).length + 1, 'SENT count');
        eq((await A.request('GET', '/captures?status=BOGUS')).status, 400, 'bogus status');
    });
    await step('retry of an unknown capture is 404', async () => {
        eq((await A.request('POST', '/captures/00000000-0000-0000-0000-000000000000/retry')).status, 404, 'status');
    });

    // ── Gateway A: screening delivery, the way the phone app submits ───────────────
    // An order leaves the worklist only after PACS has acknowledged every declared capture.
    section = 'A screening delivery';
    const screening = { id: `e2e-screening-${RUN}`, captures: [`e2e-${RUN}-s1`, `e2e-${RUN}-s2`] };
    const freshWorklist = async () => { const res = await A.request('GET', '/worklist'); eq(res.status, 200, `worklist (${res.text})`); return res.json.data; };
    const screened = (rows) => rows.find((e) => e.accession_number === orders.screened.accession);
    const screeningUpload = async (key, entry) => {
        const { submission: _status, ...row } = entry;      // the capture app strips the status
        const form = new FormData();
        form.append('file', new Blob([FIX.baseline], { type: 'image/jpeg' }), 'eye.jpg');
        form.append('worklist_entry', JSON.stringify(row));
        form.append('screening_id', screening.id);
        form.append('laterality', 'R'); form.append('light', 'WHITE');
        return A.request('POST', '/captures', { form, headers: { 'Idempotency-Key': key } });
    };
    let screenedEntry;
    await step('capabilities advertise delivery tracking and the worklist carries the scope', async () => {
        const capability = await A.request('GET', '/screenings/capabilities');
        eq(capability.status, 200, 'capabilities status'); eq(capability.json.data.screening_delivery, 1, 'version');
        screenedEntry = screened(await freshWorklist());
        assert(screenedEntry, 'screened order missing from worklist');
        eq(screenedEntry.source_scope, capability.json.data.source_scope, 'row scope');
        assert(!screenedEntry.submission, 'unsubmitted order already has a submission');
    });
    await step('register the manifest before any upload', async () => {
        const res = await A.request('POST', '/screenings', { body: { id: screening.id, source_scope: screenedEntry.source_scope,
            order: { accession_number: screenedEntry.accession_number, study_instance_uid: screenedEntry.study_instance_uid, step_id: screenedEntry.scheduled?.step_id ?? null },
            capture_ids: screening.captures } });
        eq(res.status, 200, `register (${res.text})`); eq(res.json.data.state, 'UPLOAD_PENDING', 'state');
    });
    await step('first capture reaches PACS; the order stays listed with its submission', async () => {
        const res = await screeningUpload(screening.captures[0], screenedEntry);
        eq(res.status, 200, `upload (${res.text})`);
        await A.waitStatus(res.json.data.id, 'SENT', 30_000);
        const row = screened(await freshWorklist());
        assert(row, 'order hidden before every declared capture reached PACS');
        eq(row.submission?.state, 'UPLOAD_PENDING', 'submission state');
    });
    await step('last capture reaches PACS; the order leaves the worklist', async () => {
        const res = await screeningUpload(screening.captures[1], screenedEntry);
        eq(res.status, 200, `upload (${res.text})`);
        await A.waitStatus(res.json.data.id, 'SENT', 30_000);
        eq((await A.request('GET', `/screenings/${screening.id}`)).json.data.state, 'COMPLETED', 'screening state');
        assert(!screened(await freshWorklist()), 'completed order still listed');
        eq((await instancesOf(orders.screened.studyUid, 2)).length, 2, 'PACS instances for the order');
    });
    await step('legacy captures (no screening_id) never hide their order', async () => {
        assert((await freshWorklist()).some((e) => e.accession_number === orders.main.accession), 'legacy order was hidden');
    });

    // ── Gateway B: the archive goes away ───────────────────────────────────────────
    const B = new Gateway('B', {
        retention: 'KEEP',
        max_send_attempts: 2,
        sync_interval_seconds: 2,
        store: { ...DIMSE, port: DEAD_PORT, called_ae: 'DCM4CHEE', calling_ae: 'VISILANT' },
    });
    const outage = {};
    let outageEntry;

    section = 'B archive down';
    await step('gateway starts with the archive unreachable', async () => {
        B.addUser();
        await B.start();
        await B.signIn();
    });
    await step('GET /health is 503, naming the store, worklist still fine', async () => {
        const res = await B.request('GET', '/health', { token: null });
        eq(res.status, 503, 'status');
        eq(res.json.status, 'degraded', 'health.status');
        eq(res.json.dicom.store.reachable, false, 'store reachable');
        assert(res.json.dicom.store.detail, 'store failure has no detail');
        eq(res.json.dicom.mwl.reachable, true, 'mwl reachable');
    });
    await step('worklist still works', async () => {
        const res = await B.request('GET', `/worklist?accession_number=${orders.outage.accession}`);
        eq(res.status, 200, 'status');
        outageEntry = res.json.data[0];
        assert(outageEntry, 'outage order not in worklist');
    });
    await step('captures are still accepted — a PACS outage never costs a photograph', async () => {
        for (const key of ['willFail', 'willCrash']) {
            const res = await B.capture(outageEntry, { laterality: key === 'willFail' ? 'R' : 'L', light: 'WHITE' });
            eq(res.status, 200, `${key} status (${res.text})`);
            outage[key] = res.json.data;
        }
    });
    await step('the immediate send fails into backoff: PENDING, attempt 1, error recorded', async () => {
        for (const shot of Object.values(outage)) {
            const row = await waitFor('first attempt', async () => {
                const r = (await B.captures()).find((c) => c.id === shot.id);
                return r?.attempts >= 1 ? r : null;
            }, 40_000);
            eq(row.status, 'PENDING', 'status');
            eq(row.attempts, 1, 'attempts');
            assert(row.next_attempt_at && new Date(row.next_attempt_at) > new Date(), 'no future next_attempt_at');
            assert(/C-STORE/.test(row.last_error ?? ''), `last_error does not name the step: ${row.last_error}`);
        }
    });
    await step('POST /captures/sync respects the backoff (nothing due)', async () => {
        const res = await B.request('POST', '/captures/sync');
        eq(res.status, 200, 'status');
        eq(res.json.data, { sent: 0, failed: 0 }, 'tick result');
    });
    await step('manual retry past max_send_attempts parks it as FAILED', async () => {
        eq((await B.request('POST', `/captures/${outage.willFail.id}/retry`)).status, 200, 'retry status');
        await B.request('POST', '/captures/sync');
        const row = await B.waitStatus(outage.willFail.id, 'FAILED', 40_000);
        eq(row.attempts, 2, 'attempts');
    });
    await step('the DICOM file is kept while unsent', async () => {
        const files = readdirSync(path.join(B.config.storage_root, orders.outage.accession));
        eq(files.length, 2, '.dcm files on disk');
    });

    section = 'B power loss + recovery';
    await step('gateway stops; a capture is left mid-send (simulated power cut)', async () => {
        await B.stop();
        const db = B.db();
        db.prepare("UPDATE capture SET status = 'SENDING' WHERE id = ?").run(outage.willCrash.id);
        db.close();
    });
    await step('archive comes back: restart with the right store port', async () => {
        B.config.store = { ...DIMSE, called_ae: 'DCM4CHEE', calling_ae: 'VISILANT' };
        B.writeConfig();
        await B.start();
        const res = await B.request('GET', '/health', { token: null });
        eq(res.status, 503, `health status (${res.text})`);
        eq(res.json.detail, '1 captures need attention', 'parked capture detail');
        eq(res.json.dicom.store.reachable, true, 'store recovered');
    });
    await step('boot recovery logged and the orphaned capture is SENT by the worker', async () => {
        assert(/recovered 1 capture/.test(B.log()), 'no boot-recovery log line');
        await B.waitStatus(outage.willCrash.id, 'SENT', 30_000);
    });
    await step('a token issued before the restart still works', async () => {
        eq((await B.request('GET', '/captures')).status, 200, 'status');
    });
    await step('health reports 503 while a capture remains parked', async () => {
        const res = await B.request('GET', '/health', { token: null });
        eq(res.status, 503, 'health status');
        eq(res.json.queue.FAILED, 1, 'failed count');
        eq(res.json.detail, '1 captures need attention', 'health detail');
    });
    await step('a FAILED capture stays parked until someone retries it', async () => {
        await sleep(3000);
        eq((await B.captures()).find((c) => c.id === outage.willFail.id).status, 'FAILED', 'status');
    });
    await step('POST /captures/:id/retry → SENT', async () => {
        eq((await B.request('POST', `/captures/${outage.willFail.id}/retry`)).status, 200, 'retry status');
        await B.request('POST', '/captures/sync');
        await B.waitStatus(outage.willFail.id, 'SENT', 30_000);
    });
    section = 'capture reads';
    await step('retained preview is the encapsulated JPEG, tags are curated, and DICOM downloads stream', async () => {
        const id = outage.willFail.id, headers = { Authorization: `Bearer ${B.token}` };
        const preview = await fetch(`${B.url}/captures/${id}/preview`, { headers });
        eq(preview.status, 200, 'preview status'); eq(preview.headers.get('content-type'), 'image/jpeg', 'preview type');
        eq(preview.headers.get('cache-control'), 'no-store', 'preview caching');
        eq([...new Uint8Array(await preview.arrayBuffer()).slice(0, 2)], [255, 216], 'JPEG SOI');
        const tags = await B.request('GET', `/captures/${id}/tags`); eq(tags.status, 200, 'tags status');
        eq(tags.json.data.accession_number, orders.outage.accession, 'accession');
        eq(tags.json.data.transfer_syntax_uid, '1.2.840.10008.1.2.4.50', 'transfer syntax'); eq(tags.json.data.assessment, null, 'no AI assessment');
        eq(tags.json.data.light_path_filter.code_value, '111609', 'white light has no filter');
        const dicom = await fetch(`${B.url}/captures/${id}/dicom`, { headers }); eq(dicom.status, 200, 'dicom status');
        assert(dicom.headers.get('content-disposition').includes(`${id}.dcm`), 'DICOM filename');
        eq(dicom.headers.get('cache-control'), 'no-store', 'DICOM caching');
        const bytes = new Uint8Array(await dicom.arrayBuffer()); eq(Buffer.from(bytes.slice(128, 132)).toString(), 'DICM', 'DICOM file marker');
    });
    await step('study filtering computes present files on KEEP and removed files on DELETE_ON_SENT', async () => {
        for (const [gateway, uid, present] of [[B, orders.outage.studyUid, true], [A, orders.main.studyUid, false]]) {
            const result = await gateway.request('GET', `/captures?study_instance_uid=${encodeURIComponent(uid)}`);
            eq(result.status, 200, 'study status'); assert(result.json.data.length > 0, 'empty study');
            for (const row of result.json.data) { eq(row.study_instance_uid, uid, 'study UID'); eq(row.file_present, present, 'file presence'); assert(!('dicom_path' in row), 'server storage key leaked'); }
        }
        const removed = shots.rWhite1.id;
        for (const route of ['preview', 'tags', 'dicom']) {
            const result = await A.request('GET', `/captures/${removed}/${route}`); eq(result.status, 404, route); eq(result.json.error, 'file no longer on disk', 'removed file message');
        }
        eq((await B.request('GET', '/captures?study_instance_uid=invalid')).status, 400, 'invalid UID');
        eq((await B.request('GET', '/captures?status=invalid')).status, 400, 'invalid status');
    });
    section = 'B power loss + recovery';
    await step('both outage captures are in the PACS under the order', async () => {
        const m = await instancesOf(orders.outage.studyUid, 2);
        eq(m.length, 2, 'instances');
        eq(m.map((x) => v(x, '00080018')).sort(), [outage.willFail.sop_instance_uid, outage.willCrash.sop_instance_uid].sort(), 'SOP UIDs');
    });
    await step('re-sending a stored capture is idempotent (no duplicate in PACS)', async () => {
        eq((await B.request('POST', `/captures/${outage.willCrash.id}/retry`)).status, 200, 'retry status');
        await B.request('POST', '/captures/sync');
        await B.waitStatus(outage.willCrash.id, 'SENT', 30_000);
        await sleep(2000);
        // The C-STORE really ran twice — otherwise "no duplicate" proves nothing.
        const stores = B.log().split('\n').filter((l) => l.includes(`capture ${outage.willCrash.id} stored to archive`));
        eq(stores.length, 2, 'C-STOREs of the re-sent capture');
        eq((await qido(`/studies/${orders.outage.studyUid}/instances`)).length, 2, 'instances after re-send');
    });

    section = 'recording from the operator page';
    let segmentId;
    await step('recording toggle starts a segment', async () => {
        const on = await B.request('PUT', '/diagnostics/recording', { body: { enabled: true } }); eq(on.status, 200, 'toggle status'); eq(on.json.data.enabled, true, 'enabled');
        const overview = await B.request('GET', '/diagnostics');
        const segment = overview.json.data.segments.find(s => s.active); assert(segment, 'no active segment'); eq(segment.status, 'recording', 'segment status'); segmentId = segment.id;
        eq((await B.request('PUT', '/diagnostics/recording', { body: { enabled: 'yes' } })).status, 400, 'toggle validates booleans');
    });
    await step('recorded delivery appears in the segment roll-up', async () => {
        eq((await B.request('POST', `/captures/${outage.willCrash.id}/retry`)).status, 200, 'retry status');
        await B.request('POST', '/captures/sync'); await B.waitStatus(outage.willCrash.id, 'SENT', 30_000);
        const detail = await B.request('GET', `/diagnostics/segments/${segmentId}`); eq(detail.status, 200, 'segment status');
        assert(detail.json.data.events.some(e => e.name === 'capture.delivered' && e.count > 0), 'delivery event missing'); assert(Array.isArray(detail.json.data.runs), 'runs is not an array');
    });
    await step('segment archive is a valid ZIP with no-store headers', async () => {
        const res = await fetch(`${B.url}/diagnostics/segments/${segmentId}/archive`, { headers: { Authorization: `Bearer ${B.token}` } });
        eq(res.status, 200, 'archive status'); eq(res.headers.get('content-type'), 'application/zip', 'archive type'); eq(res.headers.get('cache-control'), 'no-store', 'archive caching');
        assert(res.headers.get('content-disposition').includes(`${segmentId}.zip`), 'archive filename');
        const bytes = Buffer.from(await res.arrayBuffer()); eq([...bytes.subarray(0, 4)], [80, 75, 3, 4], 'ZIP signature');
        const file = path.join(B.dir, 'segment.zip'); writeFileSync(file, bytes); assert(run('unzip', ['-Z1', file]).includes(`${segmentId}/manifest.json`), 'archive layout');
    });
    await step('turning recording off closes the segment and persists the setting', async () => {
        const off = await B.request('PUT', '/diagnostics/recording', { body: { enabled: false } }); eq(off.status, 200, 'toggle off status'); eq(off.json.data.enabled, false, 'recording off');
        const overview = await B.request('GET', '/diagnostics'); eq(overview.json.data.segments.find(s => s.id === segmentId).status, 'stopped', 'segment stopped');
        const db = B.db(); eq(db.prepare("SELECT value FROM setting WHERE key = 'diagnostics.recording'").get().value, 'off', 'durable recording state'); db.close();
    });

    // ── PHI never leaves the .dcm files ───────────────────────────────────────────
    section = 'PHI';
    for (const gw of [A, B]) {
        await step(`gateway ${gw.name}: no patient identifiers in the database`, () => {
            const db = gw.db();
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
            const dump = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
            db.close();
            // Proves the dump is the real queue: the accession (an order ID) is meant to be there.
            assert(dump.includes(gw === A ? orders.main.accession : orders.outage.accession), 'database dump has no captures');
            const hits = PHI.filter((s) => dump.includes(s));
            eq(hits, [], 'PHI found in SQLite');
        });
        await step(`gateway ${gw.name}: no patient identifiers in the logs`, () => {
            const log = gw.log();
            assert(/capture [0-9a-f-]+ queued/.test(log), 'log has no capture activity');
            eq(Object.values(orders).map(order => order.accession).filter(accession => log.includes(accession)), [], 'accessions found in logs');
            const hits = PHI.filter((s) => log.includes(s));
            eq(hits, [], 'PHI found in logs');
        });
    }

    section = 'shutdown';
    await step('both gateways stop cleanly on SIGTERM', async () => {
        await A.stop();
        await B.stop();
        eq([A.proc.exitCode, B.proc.exitCode], [0, 0], 'exit codes');
    });
}

function summary() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}`);
    if (failed.length) {
        console.log('\nfailed:');
        for (const f of failed) console.log(`  - ${f.label}`);
        console.log(`\ngateway logs and databases kept in ${work}`);
    } else if (KEEP) {
        console.log(`kept ${work}`);
    } else {
        rmSync(work, { recursive: true, force: true });
    }
    return failed.length === 0;
}

main()
    .catch((err) => {
        results.push({ label: 'harness', ok: false, error: err });
        console.error(err);
    })
    .finally(() => {
        for (const child of children) child.kill('SIGKILL');
        process.exit(summary() ? 0 : 1);
    });
