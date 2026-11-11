import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../src/presentation/ui/app.js'), 'utf8');
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function page(fetchRoute: (url: string) => Promise<Response>, hash = '#/queue') {
    const root = { innerHTML: '', prepend: jest.fn() };
    const account = { innerHTML: '' };
    const incoming = { innerHTML: '' }, explanation = { innerHTML: '' };
    const timeouts = new Map<number, { callback: () => void; delay: number }>();
    let nextTimeout = 0;
    const storage = new Map([['token', 'old-token'], ['refresh_token', 'old-refresh']]);
    const documentEvents: Record<string, (event: unknown) => Promise<void>> = {};
    const windowEvents: Record<string, () => void> = {};
    const location = { hash };
    const fetch = jest.fn((url: string, _init?: RequestInit) => url === '/health' ? Promise.resolve(json({})) : fetchRoute(url));
    const confirm = jest.fn(() => true);
    vm.runInNewContext(source, {
        document: {
            getElementById: (id: string) => id === 'root' ? root : id === 'incoming-worklist-records' ? incoming : id === 'worklist-result' ? explanation : account,
            querySelectorAll: () => [],
            body: { classList: { toggle() {} } },
            addEventListener: (name: string, callback: (event: unknown) => Promise<void>) => { documentEvents[name] = callback; },
        },
        window: { addEventListener: (name: string, callback: () => void) => { windowEvents[name] = callback; } },
        location,
        sessionStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
        fetch, Headers, FormData,
        URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} },
        setInterval: () => 1, clearInterval() {}, confirm,
        setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimeout; timeouts.set(id, { callback, delay }); return id; },
        clearTimeout: (id: number) => timeouts.delete(id),
    });
    return { root, storage, documentEvents, windowEvents, location, fetch, confirm, incoming, explanation, timeouts };
}

test('a refresh finishing after sign-out cannot restore the session', async () => {
    let finishRefresh!: (response: Response) => void;
    const ui = page(async url => {
        if (url === '/refresh') return new Promise<Response>(resolve => { finishRefresh = resolve; });
        return json({}, 401);
    });
    await settle();
    expect(finishRefresh).toBeDefined();
    await ui.documentEvents.click({
        target: { closest: () => ({ dataset: { action: 'signout' }, disabled: false }) },
        preventDefault() {},
    });
    finishRefresh(json({ token: 'new-token', refresh_token: 'new-refresh' }));
    await settle();
    expect(ui.storage.has('token')).toBe(false);
    expect(ui.storage.has('refresh_token')).toBe(false);
    expect(ui.root.innerHTML).toContain('<h1>Sign in</h1>');
    expect(ui.fetch.mock.calls.filter(([url]) => url === '/captures')).toHaveLength(1);
});

test('queue fields are escaped before inserting them into the page', async () => {
    const ui = page(async () => json([{ id: 'capture', accession_number: '<script>patient</script>', status: 'FAILED', last_error: '<img src=x onerror=alert(1)>' }]));
    await settle();
    expect(ui.root.innerHTML).toContain('&lt;script&gt;patient&lt;/script&gt;');
    expect(ui.root.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(ui.root.innerHTML).not.toContain('<script>');
    expect(ui.root.innerHTML).not.toContain('<img');
});

test('a slow queue response cannot overwrite a newer route', async () => {
    let finishQueue!: (response: Response) => void;
    const ui = page(async url => url === '/captures'
        ? new Promise<Response>(resolve => { finishQueue = resolve; })
        : json({ config: { store: {} }, uptime_seconds: 1 }));
    ui.location.hash = '#/config';
    ui.windowEvents.hashchange();
    await settle();
    expect(ui.root.innerHTML).toContain('<h1>Config</h1>');
    finishQueue(json([]));
    await settle();
    expect(ui.root.innerHTML).toContain('<h1>Config</h1>');
    expect(ui.root.innerHTML).not.toContain('<h1>Queue</h1>');
});

test.each([
    ['R-1020E', '111609', 'White light'],
    ['R-1020E', '111603', 'Blue light'],
    ['R-1020F', '111609', 'Slit'],
    ['R-1020E', undefined, 'Capture'],
])('capture illumination %s with filter %s displays %s', async (illumination, filter, label) => {
    const row = { id: 'capture', study_instance_uid: 'study', accession_number: 'demo', file_present: true };
    const ui = page(async url => {
        if (url === '/captures/capture') return json(row);
        if (url.startsWith('/captures?')) return json([row]);
        if (url === '/system/config') return json({ config: { store: { called_ae: 'PACS' } } });
        if (url.endsWith('/preview')) return new Response('jpeg');
        return json({
            image_laterality: 'R',
            illumination: { code_value: illumination, code_meaning: 'Dual diffuse direct illumination' },
            light_path_filter: filter ? { code_value: filter } : null,
        });
    }, '#/captures/capture');
    await settle();
    expect(ui.root.innerHTML).toContain(`<h2>${label}</h2>`);
    expect(ui.root.innerHTML).not.toContain('<h2>Dual diffuse direct illumination</h2>');
});

test.each([
    ['RAMACHANDRAN^LAKSHMI', 'Lakshmi Ramachandran'],
    ['KUMAR^RAJESH^S', 'Rajesh S Kumar'],
    ['  bai^meera  ', 'Meera Bai'],
    ['', 'Capture files'],
])('capture heading shows PN %p as %p', async (pn, heading) => {
    const row = { id: 'capture', study_instance_uid: 'study', accession_number: 'demo', file_present: true };
    const ui = page(async url => {
        if (url === '/captures/capture') return json(row);
        if (url.startsWith('/captures?')) return json([row]);
        if (url === '/system/config') return json({ config: { store: { called_ae: 'PACS' } } });
        if (url.endsWith('/preview')) return new Response('jpeg');
        return json({ image_laterality: 'R', patient_name: pn });
    }, '#/captures/capture');
    await settle();
    expect(ui.root.innerHTML).toContain(`<h1>${heading}</h1>`);
});

const screening = (id: string, state: string, extra = {}) => ({
    id, state, order: { accession_number: `<b>${id}</b>`, study_instance_uid: '1.2', step_id: null },
    created_at: '2026-10-01T00:00:00.000Z', last_activity_at: '2026-10-02T00:00:00.000Z', completed_at: null,
    released_at: null, released_by: null, release_reason: null,
    captures: [{ capture_id: 'a', gateway_capture_id: 'g', status: 'SENT' }, { capture_id: 'b', gateway_capture_id: null, status: 'MISSING' }], ...extra,
});
function releaseClick(ui: ReturnType<typeof page>, reason: string) {
    const button = { dataset: { action: 'release', id: 'stuck', accession: 'ACC-1' }, disabled: false, closest: () => ({ querySelector: () => ({ value: reason }) }) };
    return ui.documentEvents.click({ target: { closest: () => button }, preventDefault() {} });
}

test('screenings page lists unfinished and released screenings, escaped', async () => {
    const ui = page(async () => json([screening('stuck', 'UPLOAD_PENDING'), screening('gone', 'RELEASED', { released_at: '2026-10-03T00:00:00.000Z', released_by: 'system:expiry', release_reason: 'EXPIRED' })]), '#/screenings');
    await settle();
    expect(ui.fetch).toHaveBeenCalledWith('/screenings?view=unfinished', expect.anything());
    expect(ui.root.innerHTML).toContain('<h1>Screenings</h1>');
    expect(ui.root.innerHTML).toContain('&lt;b&gt;stuck&lt;/b&gt;');
    expect(ui.root.innerHTML).not.toContain('<b>stuck</b>');
    expect(ui.root.innerHTML).toContain('1 of 2 in PACS · 1 missing');
    expect(ui.root.innerHTML).toContain('No activity (automatic)');
    expect(ui.root.innerHTML).toContain('data-action="release" data-id="stuck"');
    expect(ui.root.innerHTML).not.toContain('data-id="gone"');
});

test('release posts the chosen reason after confirmation, and does nothing without a reason', async () => {
    const ui = page(async () => json([screening('stuck', 'NEEDS_ATTENTION')]), '#/screenings');
    await settle();
    await releaseClick(ui, '');
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.root.innerHTML).toContain('Choose a reason, then release.');
    ui.confirm.mockReturnValueOnce(false);
    await releaseClick(ui, 'PHONE_LOST');
    expect(ui.fetch.mock.calls.some(([url]) => url.endsWith('/release'))).toBe(false);
    await releaseClick(ui, 'PHONE_LOST'); await settle();
    const call = ui.fetch.mock.calls.find(([url]) => url === '/screenings/stuck/release');
    expect(call?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ reason: 'PHONE_LOST' }) });
    expect(ui.root.innerHTML).toContain('Released ACC-1.');
});

const worklistReport = {
    build: 'unverified', node_version: 'v22.0.0', recording: false,
    checks: [{ id: 'check-reference', request_id: 'request-reference', source: 'gateway_probe', outcome: 'no_usable_rows',
        started_at: '2026-11-04T12:00:00Z', duration_ms: 10, recording: false, filters: { station: true },
        counts: { extracted_files: 3, parsed_datasets: 3, converted_files: 3, candidate_rows: 3, accepted_rows: 0, rejected_rows: 3,
            missing_accession: 2, missing_patient_id: 0, missing_both: 1, derived_study_uid: 0, invalid_json: 0, hidden_completed_rows: 0, returned_rows: 0 } }],
};
test.each([true, false])('worklist explanation separates gateway evidence and restricts filter controls (admin=%s)', async admin => {
    const ui = page(async url => json(url.endsWith('/settings') ? { filters: { scheduled_station_ae: '<SYNTHETIC>', requested_procedure_id: '', modality: '' }, source: 'operator', revision: 'revision', can_edit: admin } : worklistReport), '#/diagnostics/worklist');
    await settle();
    expect(ui.root.innerHTML).toContain('3 candidate rows have no order number');
    expect(ui.root.innerHTML).toContain('1 candidate row has no patient ID');
    expect(ui.root.innerHTML).toContain('Phone display: not observed');
    expect(ui.root.innerHTML).toContain('Hospital order completion: not integrated');
    expect(ui.root.innerHTML).toContain('&lt;SYNTHETIC&gt;');
    expect(ui.root.innerHTML).not.toContain('<SYNTHETIC>');
    expect(ui.root.innerHTML.includes('data-action="worklist-preview"')).toBe(admin);
    expect(ui.root.innerHTML.includes('data-action="worklist-inspect"')).toBe(admin);
    expect(ui.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

const inspectedRecords = {
    check: worklistReport.checks[0],
    query: { host: 'synthetic', port: 104, called_ae: 'TEST_MWL', calling_ae: 'VISILANT', scheduled_station_ae: '', modality: '', requested_procedure_id: '' },
    omitted_records: 0, omitted_candidate_details: 0,
    records: [{ dataset_index: 1, dicom_json: JSON.stringify({
        '00080050': { vr: 'SH', Value: ['00098'] },
        '00100020': { vr: 'LO', Value: ['<img src=x onerror=alert(1)>'] },
        '00100010': { vr: 'PN', Value: [{ Alphabetic: 'CANARY^PATIENT' }] },
        '00400100': { vr: 'SQ', Value: [{ '00400009': { vr: 'SH', Value: ['STEP-1'] } }] },
    }), candidates: [{ step_index: 1, outcome: 'accepted', effective_study_uid: '1.2.3', study_uid_source: 'derived' }] }],
};
const inspectorPage = (inspect: () => Promise<Response> = async () => json(inspectedRecords)) => page(async url => {
    if (url.endsWith('/inspect')) return inspect();
    if (url.endsWith('/settings')) return json({ can_edit: true, filters: {}, source: 'config_file' });
    if (url === '/system/config') return json({ config: {}, uptime_seconds: 1 });
    return json(worklistReport);
}, '#/diagnostics/worklist');
const click = (ui: ReturnType<typeof page>, action: string) => ui.documentEvents.click({ target: { closest: () => ({ dataset: { action }, disabled: false }) }, preventDefault() {} });

test('incoming records are explicitly requested, preserve identifiers, escape markup and clear after five minutes', async () => {
    const ui = inspectorPage(); await settle();
    expect(ui.fetch.mock.calls.some(([url]) => url.endsWith('/inspect'))).toBe(false);
    await click(ui, 'worklist-inspect');
    expect(ui.incoming.innerHTML).toContain('fresh query using saved filters');
    expect(ui.incoming.innerHTML).toContain('[&quot;00098&quot;]');
    expect(ui.incoming.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(ui.incoming.innerHTML).not.toContain('<img');
    expect(ui.incoming.innerHTML).toContain('Not sent');
    expect(ui.incoming.innerHTML).toContain('Gateway Study UID (derived)');
    expect(ui.incoming.innerHTML).toContain('CANARY^PATIENT');
    expect(JSON.stringify([...ui.storage])).not.toContain('CANARY');
    expect(ui.fetch.mock.calls.find(([url]) => url.endsWith('/inspect'))?.[1]).toMatchObject({ method: 'POST', cache: 'no-store' });
    [...ui.timeouts.values()].find(task => task.delay === 300000)!.callback();
    expect(ui.incoming.innerHTML).not.toContain('CANARY');
    expect(ui.incoming.innerHTML).toContain('Records cleared');
});

test.each(['worklist-inspection-clear', 'check-refresh', 'signout', 'navigate', 'pagehide'])('a late inspector response cannot repopulate records after %s', async action => {
    let finish!: (response: Response) => void;
    const ui = inspectorPage(() => new Promise(resolve => { finish = resolve; })); await settle();
    const pending = click(ui, 'worklist-inspect'); await settle();
    if (action === 'navigate') { ui.location.hash = '#/config'; ui.windowEvents.hashchange(); }
    else if (action === 'pagehide') ui.windowEvents.pagehide();
    else await click(ui, action);
    finish(json(inspectedRecords)); await pending; await settle();
    expect(ui.incoming.innerHTML).not.toContain('CANARY');
    expect(ui.timeouts.size).toBe(0);
});

test('an old inspection failure cannot clear a newer inspection', async () => {
    let finish!: (response: Response) => void;
    let count = 0;
    const ui = inspectorPage(() => ++count === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(json(inspectedRecords)));
    await settle();
    const old = click(ui, 'worklist-inspect'); await settle();
    await click(ui, 'worklist-inspection-clear');
    await click(ui, 'worklist-inspect');
    finish(json({}, 409)); await old;
    expect(ui.incoming.innerHTML).toContain('CANARY^PATIENT');
});

test('a rejected incoming row and inspection omissions remain explicit', async () => {
    const ui = inspectorPage(async () => json({ ...inspectedRecords, omitted_records: 2, records: [{ dataset_index: 1,
        dicom_json: '{"00080050":{"vr":"SH","Value":[""]}}',
        candidates: [{ step_index: null, outcome: 'missing_both', effective_study_uid: null }] }] }));
    await settle(); await click(ui, 'worklist-inspect');
    expect(ui.incoming.innerHTML).toContain('Rejected: both identifiers missing');
    expect(ui.incoming.innerHTML).toContain('[&quot;&quot;]');
    expect(ui.incoming.innerHTML).toContain('2 whole records');
    expect(ui.incoming.innerHTML).not.toContain('Gateway Study UID');
    await click(ui, 'worklist-inspection-clear');
    expect(ui.incoming.innerHTML).toBe('');
    expect(ui.timeouts.size).toBe(0);
});

const phoneSummary = {
    device_id: '11111111-2222-4333-8444-555555555555',
    manufacturer: 'Google',
    device_model: 'Pixel 7a <script>x</script>',
    android_version: '14',
    api_level: 34,
    app_version: '2.3.0',
    model_revision: 'eye-2026.10',
    first_seen_at: '2026-11-10T08:00:00.000Z',
    last_seen_at: '2026-11-11T09:30:00.000Z',
    status: {
        battery_level: 76,
        charging: true,
        battery_temperature_c: 36.4,
        power_save: false,
        thermal_status: 1,
        network_kind: 'wifi',
        wifi_connected: true,
        seeker_connected: true,
        seeker_generation: 3,
        pending_uploads: 2,
        failed_uploads: 1,
        free_storage_bytes: 4 * 1024 * 1024 * 1024,
    },
    counts: {
        events: 42,
        crashes: 2,
        seeker_disconnects: 3,
        wifi_disconnects: 1,
        captures_taken: 18,
        assessments_ready: 5,
        assessments_unavailable: 1,
    },
};

const phoneDetailFixture = {
    phone: phoneSummary,
    crashes: [{
        crash_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        source: 'js',
        utc_ms: 1700000001000,
        error_type: 'TypeError<img src=x>',
        message: 'Cannot read property of undefined <script>alert(1)</script>',
        stack: ['at CaptureScreen (screens/CaptureScreen.js:42:9)', 'at evil (<svg onload=alert(1)>)'],
        route: 'Capture<b>',
        run_id: null,
        operation_id: null,
        device_state: phoneSummary.status,
        app_version: '2.3.0',
        received_at: '2026-11-11T09:30:00.000Z',
    }],
    connectivity: [
        { stream: 'events', name: 'seeker.disconnected', sequence: 10, utc_ms: 1700000000000, duration_ms: null, outcome: 'ok', run_id: null, operation_id: null, span_id: null, attributes: { seeker_reason: 'heartbeat_timeout', seeker_generation: 3 } },
        { stream: 'events', name: 'network.restored', sequence: 11, utc_ms: 1700000005000, duration_ms: null, outcome: 'ok', run_id: null, operation_id: null, span_id: null, attributes: { network_kind: 'wifi', wifi_connected: true, offline_duration_ms: 4500 } },
    ],
    captures_and_models: {
        spans: [{ name: 'phone.capture.burst.ok', count: 6, p50_ms: 48.5, p95_ms: 92, p99_ms: 92, max_ms: 92, small_sample: true }],
        detector: { bursts_auto: 4, bursts_manual: 2, suggested_kept: 5, suggested_overridden: 1, quality_score_p50: 132.5, quality_score_p95: 188.0 },
        assessments: {
            ready: 5,
            eye_not_detected: 1,
            failed_or_timeout: 0,
            by_task: { cornea: { normal: 4, scar: 1 }, lens: { clear: 3, immature: 2 }, pterygium: { negative: 5 } },
            confidence_p50: { cornea: 0.92, lens: 0.84, pterygium: 0.96 },
            entropy_p50: { cornea: 0.14, lens: 0.31, pterygium: 0.08 },
        },
    },
    recent_events: [
        { stream: 'events', name: 'capture.burst', sequence: 12, utc_ms: 1700000006000, duration_ms: 48.5, outcome: 'ok', run_id: null, operation_id: null, span_id: null, attributes: { trigger: 'auto', shot_count: 3 } },
    ],
    resources: [
        { name: 'resource.sample', utc_ms: 1700000007000, battery_level: 76, battery_temperature_c: 36.4, thermal_status: 1, cpu_percent: 18.2, pss_bytes: 120 * 1024 * 1024, available_memory_bytes: 2 * 1024 * 1024 * 1024 },
    ],
    malformed_lines: 0,
};

test('diagnostics overview and phones list render connected phones link and summary table with escaped values', async () => {
    const ui = page(async url => {
        if (url === '/diagnostics') return json({ recording: { enabled: false, locked_by: null, directory: '/tmp/diag' }, segments: [] });
        if (url === '/diagnostics/phones') return json({ phones: [phoneSummary] });
        return json({});
    }, '#/diagnostics');
    await settle();
    expect(ui.root.innerHTML).toContain('href="#/diagnostics/phones"');
    expect(ui.root.innerHTML).toContain('Connected phones, crashes &amp; model telemetry');
    expect(ui.root.innerHTML).toContain(`#/diagnostics/phones/${phoneSummary.device_id}`);
    expect(ui.root.innerHTML).toContain('Pixel 7a &lt;script&gt;x&lt;/script&gt;');
    expect(ui.root.innerHTML).not.toContain('<script>x</script>');

    ui.location.hash = '#/diagnostics/phones';
    ui.windowEvents.hashchange();
    await settle();
    expect(ui.root.innerHTML).toContain(`#/diagnostics/phones/${phoneSummary.device_id}`);
    expect(ui.root.innerHTML).toContain('2.3.0');
    expect(ui.root.innerHTML).toContain('eye-2026.10');
});

test('phone detail page renders device status, crashes, connectivity, capture & model telemetry, spans, and escapes XSS', async () => {
    const ui = page(async url => {
        if (url === `/diagnostics/phones/${phoneSummary.device_id}`) return json(phoneDetailFixture);
        return json({});
    }, `#/diagnostics/phones/${phoneSummary.device_id}`);
    await settle();
    const html = ui.root.innerHTML;
    // Device status card + download zip button
    expect(html).toContain('76%');
    expect(html).toContain('4.0 GiB');
    expect(html).toContain(`data-action="phone-archive" data-id="${phoneSummary.device_id}"`);
    // Crashes section with expandable details
    expect(html).toContain('TypeError&lt;img src=x&gt;');
    expect(html).toContain('Cannot read property of undefined &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Capture&lt;b&gt;');
    expect(html).toContain('<details');
    expect(html).toContain('at CaptureScreen (screens/CaptureScreen.js:42:9)');
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<svg onload=');
    // Connectivity log
    expect(html).toContain('seeker.disconnected');
    expect(html).toContain('heartbeat_timeout');
    expect(html).toContain('network.restored');
    expect(html).toContain('4500');
    // Capture & AI Model summary + spans
    expect(html).toContain('132.5');
    expect(html).toContain('188.0');
    expect(html).toContain('normal: 4');
    expect(html).toContain('scar: 1');
    expect(html).toContain('0.92');
    expect(html).toContain('0.14');
    expect(html).toContain('phone.capture.burst.ok');
});
