import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../src/presentation/ui/app.js'), 'utf8');
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function page(fetchRoute: (url: string) => Promise<Response>, hash = '#/queue') {
    const root = { innerHTML: '', prepend: jest.fn() };
    const account = { innerHTML: '' };
    const storage = new Map([['token', 'old-token'], ['refresh_token', 'old-refresh']]);
    const documentEvents: Record<string, (event: unknown) => Promise<void>> = {};
    const windowEvents: Record<string, () => void> = {};
    const location = { hash };
    const fetch = jest.fn((url: string, _init?: RequestInit) => url === '/health' ? Promise.resolve(json({})) : fetchRoute(url));
    const confirm = jest.fn(() => true);
    vm.runInNewContext(source, {
        document: {
            getElementById: (id: string) => id === 'root' ? root : account,
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
    });
    return { root, storage, documentEvents, windowEvents, location, fetch, confirm };
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
