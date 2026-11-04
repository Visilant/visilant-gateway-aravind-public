(() => {
  'use strict';
  const root = document.getElementById('root');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let sessionVersion = 0;
  const session = {
    get: key => sessionStorage.getItem(key),
    save(data) { sessionStorage.setItem('token', data.token); sessionStorage.setItem('refresh_token', data.refresh_token); if (data.user) sessionStorage.setItem('email', data.user.email); },
    clear() { sessionVersion++; ['token', 'refresh_token', 'email', 'signed_in_at'].forEach(key => sessionStorage.removeItem(key)); }
  };
  const views = {};
  let healthCache, refreshing, routeVersion = 0, timer, notice = '', study;
  const urls = new Set();
  // DICOM PN "FAMILY^GIVEN^MIDDLE^PREFIX^SUFFIX" -> "Given Middle Family", as the phone app shows it.
  const personName = value => {
    const [family = '', given = '', middle = ''] = String(value ?? '').trim().split('^').map(part => part.trim());
    return [given, middle, family].filter(Boolean).join(' ').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
  };
  const date = value => value ? new Date(value).toLocaleString() : '—';
  const time = value => value ? new Date(value).toLocaleTimeString() : '—';
  const fmtBytes = value => {
    if (value == null) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let n = Number(value), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  };
  const queueSeconds = row => row.enqueued_at ? Math.max(0, Math.round(((row.sent_at ? Date.parse(row.sent_at) : Date.now()) - Date.parse(row.enqueued_at)) / 1000)) : null;
  const duration = seconds => seconds == null ? '—' : `${seconds} s`;
  const pathId = value => encodeURIComponent(value);
  const linkCapture = id => `<a href="#/captures/${esc(pathId(id))}">${esc(String(id).slice(0, 8))}</a>`;
  const kv = entries => `<table class="rows kv"><tbody>${entries.map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value ?? '—')}</td></tr>`).join('')}</tbody></table>`;
  class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
  async function request(path, init = {}, retry = true) {
    const authVersion = sessionVersion;
    const headers = new Headers(init.headers);
    if (session.get('token')) headers.set('Authorization', `Bearer ${session.get('token')}`);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers, cache: 'no-store' });
    if (response.status === 401 && retry && session.get('refresh_token')) {
      refreshing ??= fetch('/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.get('refresh_token') }), cache: 'no-store' })
        .then(async r => { if (!r.ok) throw new ApiError('Sign in again', 401); const data = (await r.json()).data; if (authVersion !== sessionVersion) throw new ApiError('Sign in again', 401); session.save(data); })
        .finally(() => { refreshing = undefined; });
      try { await refreshing; return await request(path, init, false); } catch (error) { if (error.status !== 401) throw error; }
    }
    if (response.status === 401) { if (authVersion === sessionVersion) session.clear(); throw new ApiError('Sign in again', 401); }
    if (!response.ok && path !== '/health') {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(body.error || `Request failed (${response.status})`, response.status);
    }
    return response;
  }
  async function api(path, init) { const body = await (await request(path, init)).json(); return Object.hasOwn(body, 'data') ? body.data : body; }
  async function blob(path) {
    const response = await request(path);
    return { blob: await response.blob(), filename: /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'download' };
  }
  function objectUrl(value) { const url = URL.createObjectURL(value); urls.add(url); return url; }
  async function download(path) {
    const version = routeVersion;
    const result = await blob(path);
    if (version !== routeVersion || !session.get('token')) return;
    const url = objectUrl(result.blob), a = document.createElement('a');
    a.href = url; a.download = result.filename; a.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
  }
  function cleanup() { clearInterval(timer); timer = undefined; urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); study = undefined; }
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const name = parts.shift() || 'queue';
    if (!Object.hasOwn(views, name)) { location.hash = '#/queue'; return { name: 'queue', rest: [] }; }
    return { name, rest: parts };
  }
  function account() {
    document.body.classList.toggle('signed-out', !session.get('token'));
    document.getElementById('account').innerHTML = `<b>${esc(session.get('email'))}</b>${esc(healthCache?.centre_code || '—')} · signed in ${esc(time(session.get('signed_in_at')))}`;
  }
  function signin(message = '') {
    cleanup(); account();
    root.innerHTML = `<form class="login" id="signin"><h1>Sign in</h1><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button><p class="error" role="alert">${esc(message)}</p></form>`;
  }
  async function render(navigate = true) {
    if (navigate) { routeVersion++; cleanup(); notice = ''; }
    const version = routeVersion;
    if (!session.get('token')) { signin(); return; }
    const { name, rest } = route(); account();
    document.querySelectorAll('[data-view]').forEach(a => { const active = a.dataset.view === name; a.classList.toggle('on', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (navigate) root.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const html = await views[name](rest, version);
      if (version !== routeVersion) return;
      root.innerHTML = (notice ? `<p class="notice" role="status">${esc(notice)}</p>` : '') + html;
      if (!timer && ['queue', 'health', 'device'].includes(name)) timer = setInterval(() => { void render(false); }, name === 'device' ? 5000 : 15000);
    } catch (err) {
      if (version !== routeVersion) return;
      if (err.status === 401) signin(); else root.innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
    }
  }
  views.queue = async rest => {
    const statuses = ['', 'PENDING', 'SENDING', 'SENT', 'FAILED'];
    const status = statuses.includes(rest[0]) ? rest[0] : '';
    const rows = await api(`/captures${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    return `<h1>Queue</h1><div class="toolbar">${statuses.map(s => `<a class="${esc(s === status ? 'on' : '')}" href="#/queue${esc(s ? '/' + s : '')}">${esc(s ? s[0] + s.slice(1).toLowerCase() : 'All')}</a>`).join('')}<button data-action="sync">Sync now</button></div>
      <div class="table-scroll"><table class="rows"><thead><tr><th>Capture</th><th>Accession</th><th>Status</th><th class="num">Attempts</th><th>Created</th><th>Queued</th><th>Sent</th><th class="num">Time in queue</th><th>Last error</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td>${linkCapture(row.id)}</td><td>${esc(row.accession_number)}</td><td>${esc(row.status)}</td><td class="num">${esc(row.attempts)}</td><td>${esc(date(row.created_at))}</td><td>${esc(date(row.enqueued_at))}</td><td>${esc(date(row.sent_at))}</td><td class="num">${esc(duration(queueSeconds(row)))}</td><td class="error">${esc(row.last_error)}</td><td>${row.status === 'FAILED' ? `<button data-action="retry" data-id="${esc(row.id)}">Retry</button>` : ''}</td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<p class="muted">No captures.</p>'}`;
  };
  // Screenings that have not reached PACS. One that cannot finish is released here, so its
  // order returns to Patients to Screen; the gateway also releases one left idle for days.
  const releaseReasons = { PHONE_LOST: 'Phone lost or broken', CAPTURE_REJECTED: 'Image rejected or lost', RESHOOT: 'Needs a new screening', OTHER: 'Other', EXPIRED: 'No activity (automatic)' };
  const stateLabels = { UPLOAD_PENDING: 'Images missing', AWAITING_PACS: 'Sending to PACS', NEEDS_ATTENTION: 'Needs attention', RELEASED: 'Released' };
  const captureCounts = row => {
    const count = status => row.captures.filter(c => c.status === status).length;
    return [`${count('SENT')} of ${row.captures.length} in PACS`, count('MISSING') && `${count('MISSING')} missing`, count('FAILED') && `${count('FAILED')} failed`].filter(Boolean).join(' · ');
  };
  views.screenings = async () => {
    const rows = await api('/screenings?view=unfinished');
    const open = rows.filter(row => row.state !== 'RELEASED').sort((a, b) => a.last_activity_at.localeCompare(b.last_activity_at));
    const released = rows.filter(row => row.state === 'RELEASED').sort((a, b) => b.released_at.localeCompare(a.released_at));
    const reasonPicker = `<select aria-label="Release reason"><option value="">Reason…</option>${Object.entries(releaseReasons).filter(([key]) => key !== 'EXPIRED').map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('')}</select>`;
    return `<h1>Screenings</h1><p class="muted">Screenings not yet in PACS. Release one that cannot finish: its order returns to Patients to Screen, and images already delivered stay in PACS.</p>
      <div class="table-scroll"><table class="rows"><thead><tr><th>Accession</th><th>State</th><th>Captures</th><th>Registered</th><th>Last activity</th><th></th></tr></thead><tbody>${open.map(row => `<tr><td>${esc(row.order.accession_number)}</td><td class="${esc(row.state === 'NEEDS_ATTENTION' ? 'amber' : '')}">${esc(stateLabels[row.state] || row.state)}</td><td>${esc(captureCounts(row))}</td><td>${esc(date(row.created_at))}</td><td>${esc(date(row.last_activity_at))}</td><td class="release">${reasonPicker}<button data-action="release" data-id="${esc(row.id)}" data-accession="${esc(row.order.accession_number)}">Release</button></td></tr>`).join('')}</tbody></table></div>${open.length ? '' : '<p class="muted">No screenings waiting.</p>'}
      <h2>Released</h2><div class="table-scroll"><table class="rows"><thead><tr><th>Accession</th><th>Reason</th><th>Released</th><th>By</th><th>Captures</th></tr></thead><tbody>${released.map(row => `<tr><td>${esc(row.order.accession_number)}</td><td>${esc(releaseReasons[row.release_reason] || row.release_reason)}</td><td>${esc(date(row.released_at))}</td><td>${esc(row.release_reason === 'EXPIRED' ? 'Gateway' : 'Operator')}</td><td>${esc(captureCounts(row))}</td></tr>`).join('')}</tbody></table></div>${released.length ? '' : '<p class="muted">Nothing released.</p>'}`;
  };
  const flatten = (object, prefix = '') => Object.entries(object || {}).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && !Array.isArray(value) ? flatten(value, name) : [[name, value]];
  });
  const uptime = seconds => `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  const sparkline = values => {
    const series = values.filter(Number.isFinite);
    if (!series.length) return '<span class="muted">No samples</span>';
    const min = Math.min(...series), max = Math.max(...series), range = max - min || 1;
    const points = series.map((value, index) => `${series.length === 1 ? 0 : index * 220 / (series.length - 1)},${max === min ? 20 : 38 - (value - min) / range * 36}`).join(' ');
    return `<svg viewBox="0 0 220 40" role="img" aria-label="Last minute of samples"><polyline points="${esc(points)}" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>`;
  };
  views.health = async () => {
    const health = await api('/health'); healthCache = health; account();
    return `<h1>Health</h1><p class="${esc(health.status === 'ok' ? '' : 'amber')}">${esc(health.status)}${health.detail ? ` · ${esc(health.detail)}` : ''}</p>
      <h2>Database</h2>${kv([['Status', health.database.detail || (health.database.reachable ? 'reachable' : 'unreachable')]])}
      <h2>Queue</h2>${kv(health.queue ? Object.entries(health.queue) : [['Status', 'unavailable']])}
      <h2>Storage</h2>${kv([['Path', health.storage.path], ['Free disk', health.storage.detail || fmtBytes(health.storage.free_bytes)]])}
      <h2>Worklist node</h2>${kv([['Status', health.dicom.mwl.detail || (health.dicom.mwl.reachable ? 'reachable' : 'unreachable')]])}
      <h2>Store node</h2>${kv([['Status', health.dicom.store.detail || (health.dicom.store.reachable ? 'reachable' : 'unreachable')]])}`;
  };
  views.config = async () => {
    const snapshot = await api('/system/config');
    return `<h1>Config</h1><p><a href="#/diagnostics/worklist">Inspect and change worklist filters</a></p>${kv(flatten(snapshot.config).sort(([a], [b]) => a.localeCompare(b)))}<h2>Runtime</h2>${kv([['node_version', snapshot.node_version], ['package_version', snapshot.package_version], ['uptime_seconds', uptime(snapshot.uptime_seconds)], ['diagnostics_env_dir', snapshot.diagnostics_env_dir]])}`;
  };
  views.device = async () => {
    const device = await api('/system/device');
    const gauges = [
      ['CPU', 'cpu_percent', value => `${value.toFixed(1)} %`], ['RSS', 'rss_bytes', fmtBytes],
      ['Heap used', 'heap_used_bytes', fmtBytes], ['Event loop p95', 'event_loop_p95_ms', value => `${value.toFixed(1)} ms`],
      ['Free disk', 'free_bytes', fmtBytes], ['DB size', 'database_bytes', fmtBytes]
    ];
    return `<h1>Device</h1><p class="muted">Sampled ${esc(date(device.current.sampled_at))} · refreshes every 5 seconds</p><div class="gauges">${gauges.map(([label, key, format]) => `<section class="gauge"><h2>${esc(label)}</h2><div class="value">${esc(device.current[key] == null ? '—' : format(device.current[key]))}</div>${sparkline(device.history.map(sample => sample[key]))}</section>`).join('')}</div>`;
  };

  const spansTable = spans => `<h2>Spans</h2><table class="rows"><thead><tr><th>Name</th><th class="num">Count</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">p99 ms</th><th class="num">Max ms</th></tr></thead><tbody>${spans.map(row => `<tr><td class="mono">${esc(row.name)}</td><td class="num">${esc(row.count)}${row.small_sample ? ' (small)' : ''}</td>${['p50_ms', 'p95_ms', 'p99_ms', 'max_ms'].map(key => `<td class="num">${esc(row[key].toFixed(2))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const eventsTable = events => `<h2>Events</h2><table class="rows"><thead><tr><th>Name</th><th class="num">Count</th></tr></thead><tbody>${events.map(row => `<tr><td class="mono">${esc(row.name)}</td><td class="num">${esc(row.count)}</td></tr>`).join('')}</tbody></table>`;
  const captureRefs = captures => captures.length ? captures.map(row => `${linkCapture(row.id)} <span class="muted">${esc(row.status)}</span>`).join(' · ') : '—';
  const segmentLink = id => `<a class="mono" href="#/diagnostics/segments/${esc(pathId(id))}">${esc(id)}</a>`;
  views.diagnostics = async rest => {
    if (rest[0] === 'worklist') return worklistDiagnostics();
    if (!rest.length) {
      const result = await api('/diagnostics'), recording = result.recording;
      return `<h1>Diagnostics</h1><p><a href="#/diagnostics/worklist">Explain this worklist</a> — find out why an order is missing.</p><div class="toolbar"><span>${esc(recording.enabled ? `Recording on at ${recording.directory}` : 'Recording off')}</span>${recording.locked_by === 'env' ? '<span class="muted">Controlled by GATEWAY_DIAGNOSTICS_DIR on this process</span>' : `<button data-action="recording" data-enabled="${esc(!recording.enabled)}">${esc(recording.enabled ? 'Turn off' : 'Turn on')}</button>`}</div>
        <table class="rows"><thead><tr><th>Segment</th><th>Status</th><th>Started</th><th class="num">Bytes</th><th class="num">Dropped</th><th></th></tr></thead><tbody>${result.segments.map(segment => `<tr><td>${segmentLink(segment.id)}</td><td>${esc(segment.active ? 'recording' : segment.status)}</td><td>${esc(date(segment.started_at))}</td><td class="num">${esc(fmtBytes(segment.bytes))}</td><td class="num">${esc(segment.dropped_events)}</td><td><button data-action="archive" data-id="${esc(segment.id)}">Download</button></td></tr>`).join('')}</tbody></table>${result.segments.length ? '' : '<p class="muted">No recorded segments.</p>'}`;
    }
    if (rest.length === 2 && rest[0] === 'segments') {
      const detail = await api(`/diagnostics/segments/${pathId(rest[1])}`);
      return `<div class="crumbs"><a href="#/diagnostics">Diagnostics</a> › Segment</div><h1 class="mono">${esc(detail.segment.id)}</h1>${kv(Object.entries(detail.segment))}${detail.malformed_lines ? `<p class="amber">${esc(detail.malformed_lines)} malformed event line(s) skipped.</p>` : ''}${spansTable(detail.spans)}${eventsTable(detail.events)}
        <h2>Runs</h2><table class="rows"><thead><tr><th>Run</th><th class="num">Acknowledged</th><th class="num">Pending</th><th>Captures</th></tr></thead><tbody>${detail.runs.map(run => `<tr><td><a class="mono" href="#/diagnostics/runs/${esc(pathId(run.run_id))}">${esc(run.run_id)}</a></td><td class="num">${esc(run.acknowledged)}</td><td class="num">${esc(run.pending)}</td><td>${captureRefs(run.captures)}</td></tr>`).join('')}</tbody></table>`;
    }
    if (rest.length === 2 && rest[0] === 'runs') {
      const detail = await api(`/diagnostics/runs/${pathId(rest[1])}`);
      return `<div class="crumbs"><a href="#/diagnostics">Diagnostics</a> › Run</div><h1 class="mono">${esc(detail.run_id)}</h1><p>Segments: ${detail.segments.map(segmentLink).join(' · ') || '—'}</p>${kv([['Acknowledged', detail.acknowledged], ['Pending', detail.pending]])}${spansTable(detail.spans)}${eventsTable(detail.events)}<h2>Captures</h2><p>${captureRefs(detail.captures)}</p>`;
    }
    throw new ApiError('Diagnostic page not found', 404);
  };

  const checkSources = { worklist_request: 'Worklist API request (phone or other client)', gateway_probe: 'Gateway-only check', filter_preview: 'Filter preview' };
  const checkOutcomes = { rows_available: 'Usable orders found', no_usable_rows: 'Orders could not be used', no_matches: 'No matching orders received', all_completed: 'All usable orders already completed locally', failed: 'Check did not finish' };
  const checkErrors = {
    MWL_TOOL_UNAVAILABLE: 'A DICOM tool could not start. Ask IT to check the installed gateway tools.',
    MWL_TIMEOUT: 'The hospital query timed out. Ask IT to check the network and worklist server.',
    MWL_QUERY_FAILED: 'The hospital worklist query failed. Ask IT to check the server address, port and registered gateway AE title.',
    MWL_CONVERSION_FAILED: 'A hospital response could not be converted. Ask support to check the DICOM tools with a synthetic order.',
    ROW_MAPPING_FAILED: 'A hospital response could not be read as a worklist row. Ask support to inspect a synthetic response.',
    SCREENING_FILTER_FAILED: 'The gateway could not check which orders are completed. Ask support to check the gateway database.'
  };
  const filterLabels = { scheduled_station_ae: 'Station AE title', requested_procedure_id: 'Procedure ID', modality: 'Modality' };
  function explanation(check) {
    if (!check) return '<p class="muted">No worklist check observed since this gateway started. Refresh Patients to Screen on the phone, then select Refresh results. Check the phone’s gateway address if no request appears.</p>';
    const c = check.counts, advice = [];
    if (check.error_code) advice.push(checkErrors[check.error_code] || 'Ask support to inspect this check.');
    if (c.missing_accession || c.missing_both) advice.push(`${c.missing_accession + c.missing_both} ${c.missing_accession + c.missing_both === 1 ? 'candidate row has' : 'candidate rows have'} no order number. Ask AEH to put the imaging order ID into Accession Number (0008,0050) in Freedom MWL. The gateway cannot recover an order ID it did not receive.`);
    if (c.missing_patient_id || c.missing_both) advice.push(`${c.missing_patient_id + c.missing_both} ${c.missing_patient_id + c.missing_both === 1 ? 'candidate row has' : 'candidate rows have'} no patient ID. Ask AEH to check Patient ID (0010,0020) in the same worklist response.`);
    if (c.invalid_json) advice.push('Some response files could not be read as DICOM JSON. These losses are separate from orders rejected for missing identifiers.');
    if (check.outcome === 'no_matches') advice.push('Check the saved filters and ask AEH whether a synthetic anterior order is published for this station. No date is assumed.');
    if (c.hidden_completed_rows) advice.push('Orders already marked completed by this gateway are hidden. Inspect Screenings and Queue for delivery evidence.');
    if (c.returned_rows) advice.push(check.source === 'worklist_request' ? 'The gateway prepared these rows for the requesting client. If the phone still looks empty, check its gateway address, refresh and search.' : 'This is a gateway-only result. Refresh the phone separately to check what it receives.');
    return `<section class="worklist-result" aria-label="Worklist explanation"><h2>${esc(check.outcome === 'rows_available' && (c.rejected_rows || c.invalid_json) ? 'Usable orders found; some need attention' : checkOutcomes[check.outcome])}</h2>
      <p>${esc(checkSources[check.source])} · ${esc(date(check.started_at))} · ${esc(check.duration_ms)} ms</p>
      ${check.source === 'filter_preview' ? '<p class="amber">Preview check. Running it did not save the filters.</p>' : ''}
      ${check.outcome === 'failed' ? `<p class="error">Stopped at ${esc(check.stage)}. Counts are partial; “Not reached” is not zero.</p>` : ''}
      <ol class="worklist-stages">${[['Hospital files', c.extracted_files], ['Parsed datasets', c.parsed_datasets], ['Candidate steps', c.candidate_rows], ['Usable rows', c.accepted_rows], ['Hidden as completed', c.hidden_completed_rows], [check.source === 'worklist_request' ? 'Rows for client' : 'Rows available', c.returned_rows]].map(([label, value]) => `<li><strong>${esc(value ?? 'Not reached')}</strong><span>${esc(label)}</span></li>`).join('')}</ol>
      ${advice.map(text => `<p>${esc(text)}</p>`).join('')}
      <details><summary>Field checks and request evidence</summary>${kv([
        ['Missing order number only (0008,0050)', c.missing_accession], ['Missing patient ID only (0010,0020)', c.missing_patient_id],
        ['Both identifiers missing', c.missing_both], ['Rejected rows (each counted once)', c.rejected_rows],
        ['Converted files', c.converted_files], ['Invalid JSON responses', c.invalid_json], ['Study UID derived because absent', c.derived_study_uid],
        ['Active filter fields (values excluded)', Object.entries(check.filters).filter(([, active]) => active).map(([key]) => key).join(', ') || 'None'],
        ['Recording was on at start', check.recording ? 'Yes' : 'No'], ['Check reference', check.id], ['HTTP request reference', check.request_id]
      ])}</details><p class="muted">Phone display: not observed. Hospital order completion: not integrated. PACS acceptance and AEH application completion are separate.</p></section>`;
  }
  async function worklistDiagnostics() {
    const [report, settings] = await Promise.all([api('/diagnostics/worklist'), api('/diagnostics/worklist/settings')]);
    return `<div class="crumbs"><a href="#/diagnostics">Diagnostics</a> › Worklist</div><h1>Explain this worklist</h1>
      <p>Refresh Patients to Screen on the phone, then refresh these results. A gateway-only check queries the hospital directly and reads recorded completion state.</p>
      <div class="toolbar"><button data-action="check-refresh">Refresh results</button><button data-action="worklist-check">Run gateway-only check</button><button data-action="worklist-support">Download support summary</button></div>
      <p class="muted">Build: ${esc(report.build)} · Node ${esc(report.node_version)} · Recording ${report.recording ? 'on' : 'off'} (<a href="#/diagnostics">change recording</a>). Last 20 checks in this process; this list clears on restart. Recorded counters remain in diagnostic archives.</p>
      <div id="worklist-result" aria-live="polite">${explanation(report.checks[0])}</div>
      <h2>Recent checks at last refresh</h2><div class="table-scroll"><table class="rows"><thead><tr><th>Time</th><th>Source</th><th>Result</th><th></th></tr></thead><tbody>${report.checks.map(check => `<tr><td>${esc(date(check.started_at))}</td><td>${esc(checkSources[check.source])}</td><td>${esc(checkOutcomes[check.outcome])}</td><td><button data-action="worklist-detail" data-id="${esc(check.id)}">View</button></td></tr>`).join('')}</tbody></table></div>
      <h2>Worklist filters</h2><p>Use the values confirmed by AEH for anterior imaging. Blank means no filter for that field. Procedure ID is different from the examination description; OP may also include fundus orders.</p>
      <p>Current source: ${settings.source === 'operator' ? 'saved in this dashboard (overrides the config file)' : 'config file'}. Saved changes apply to the next request and survive restart.</p>
      <form id="worklist-filters" data-revision="${esc(settings.revision)}" class="worklist-filters"><fieldset ${settings.can_edit ? '' : 'disabled'}><legend>Filters used for the hospital query</legend>
      ${Object.entries(filterLabels).map(([key, label]) => `<label>${esc(label)}<input name="${esc(key)}" value="${esc(settings.filters[key])}" maxlength="16" autocomplete="off"></label>`).join('')}</fieldset>
      ${settings.can_edit ? '<div class="toolbar"><button type="button" data-action="worklist-preview">Preview these filters</button><button type="submit">Save filters</button><button type="button" data-action="worklist-reset">Restore config-file filters</button></div>' : '<p class="muted">An administrator account is needed to change filters.</p>'}
      <p class="error" role="alert"></p></form>
      <p>Previewing queries the hospital without saving. Saving affects which orders every connected phone sees. These controls cannot fill an empty hospital order number.</p>
      <p><a href="#/health">Connection health</a> · <a href="#/screenings">Screenings</a> · <a href="#/queue">Image delivery queue</a></p>`;
  }
  const formFilters = form => Object.fromEntries(Object.keys(filterLabels).map(key => [key, form.elements[key].value.trim()]));
  document.addEventListener('submit', async event => {
    if (event.target.id !== 'worklist-filters') return;
    event.preventDefault();
    const form = event.target, version = routeVersion, fields = formFilters(form);
    if (!confirm(`Apply these filters to all connected phones?\n${Object.entries(fields).map(([key, value]) => `${filterLabels[key]}: ${value || '(no filter)'}`).join('\n')}`)) return;
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try {
      await api('/diagnostics/worklist/settings', { method: 'PUT', body: JSON.stringify({ ...fields, revision: form.dataset.revision }) });
      if (version !== routeVersion) return;
      notice = 'Filters saved. Refresh the phone to use them.'; await render(false);
    } catch (error) { if (version === routeVersion) form.querySelector('.error').textContent = error.message; }
    finally { button.disabled = false; }
  });

  // Clinically reviewed display text shared with the phone's AssessmentSummary.
  const labels = { normal: 'Normal appearance', active_infection: 'Active infection', scar: 'Corneal scar', clear: 'Clear lens', immature: 'Immature cataract', mature: 'Mature cataract', pciol: 'Intraocular lens', abstain: 'Unable to classify', positive: 'Pterygium detected', negative: 'Pterygium not detected' };
  const findings = tags => {
    if (tags.assessment_error) return '<p class="error">AI assessment could not be read from this file.</p>';
    const assessment = tags.assessment;
    if (!assessment) return '<p class="none">No AI findings. The model runs on verified white-light captures only.</p>';
    if (assessment.status === 'unavailable') return '<p class="none">AI assessment unavailable for this image.</p>';
    return `<table class="findings"><thead><tr><th>AI finding</th><th>Result</th><th>Score</th></tr></thead><tbody>${['cornea', 'lens', 'pterygium'].map(key => {
      const task = assessment[key], flagged = task && !['normal', 'clear', 'negative'].includes(task.label);
      const probabilities = task ? Object.entries(task.probabilities).map(([label, value]) => `${label} ${Number(value).toFixed(2)}`).join(' · ') : '';
      return `<tr><td class="task">${esc(key[0].toUpperCase() + key.slice(1))}</td><td class="result ${esc(flagged ? 'flag' : '')}">${esc(task ? labels[task.label] || task.label : 'Unavailable')}${task ? `<div class="probs">${esc(probabilities)}${key === 'pterygium' ? `<br>threshold ${esc(Number(task.positiveThreshold).toFixed(2))}` : ''}</div>` : ''}</td><td>${esc(task ? Number(task.confidence).toFixed(2) : '—')}</td></tr>`;
    }).join('')}</tbody></table><div class="model">${esc(assessment.modelRevision)}${assessment.elapsedMs == null ? '' : ` · ${esc(assessment.elapsedMs)} ms on device`}</div>`;
  };
  const tagNames = [
    ['(0010,0010)', 'Patient name', 'patient_name'], ['(0010,0020)', 'Patient ID', 'patient_id'],
    ['(0010,0030)', 'Birth date', 'patient_birth_date'], ['(0010,0040)', 'Sex', 'patient_sex'],
    ['(0008,0050)', 'Accession', 'accession_number'], ['(0020,000D)', 'Study Instance UID', 'study_instance_uid'],
    ['(0020,000E)', 'Series Instance UID', 'series_instance_uid'], ['(0008,0018)', 'SOP Instance UID', 'sop_instance_uid'],
    ['(0008,0060)', 'Modality', 'modality'], ['(0020,0062)', 'Image Laterality', 'image_laterality'],
    ['(0008,2218)', 'Anatomic region', 'anatomic_region'],
    ['(0022,0016)', 'Illumination Type Code', 'illumination'], ['(0022,0017)', 'Light path filter', 'light_path_filter'], ['(0002,0010)', 'Transfer Syntax', 'transfer_syntax_uid'],
    ['(0011,0010)', 'Private Creator', 'private_creator'], ['(0011,1001)', 'Assessment JSON', 'assessment']
  ];
  const tagsBlock = tags => `<details class="tags"><summary>DICOM tags</summary><table><tbody>${tagNames.map(([code, label, key]) => `<tr><td>${esc(code)}</td><td>${esc(label)}</td><td>${esc(tags[key] && typeof tags[key] === 'object' ? JSON.stringify(tags[key]) : tags[key] ?? '—')}</td></tr>`).join('')}</tbody></table></details>`;
  const lightLabel = tags => {
    if (tags?.illumination?.code_value === 'R-1020F') return 'Slit';
    if (tags?.light_path_filter?.code_value === '111603') return 'Blue light';
    if (tags?.illumination?.code_value === 'R-1020E' && tags?.light_path_filter?.code_value === '111609') return 'White light';
    return 'Capture';
  };
  const captureBlock = item => {
    const { row, tags, url, error } = item;
    if (!row.file_present || item.missing) return `<section class="capture"><div class="title"><h2>Capture ${esc(row.id.slice(0, 8))}</h2></div><div class="removed">file removed</div></section>`;
    return `<section class="capture"><div class="title"><h2>${esc(lightLabel(tags))}</h2><button data-action="dicom" data-id="${esc(row.id)}">Download .dcm</button></div>${url ? `<div class="image"><img src="${esc(url)}" alt="${esc((tags?.image_laterality === 'L' ? 'Left eye' : tags?.image_laterality === 'R' ? 'Right eye' : 'Eye') + ' capture')}" /></div>` : '<div class="removed">Preview unavailable</div>'}<div>${error ? `<p class="error">${esc(error)}</p>` : tags ? findings(tags) : '<p class="none">Findings unavailable.</p>'}</div>${tags ? tagsBlock(tags) : ''}</section>`;
  };
  views.captures = async (rest, version) => {
    if (!rest.length) {
      const rows = await api('/captures'), groups = new Map();
      for (const row of rows) { if (!groups.has(row.accession_number)) groups.set(row.accession_number, []); groups.get(row.accession_number).push(row); }
      return `<h1>Captures</h1><table class="rows"><thead><tr><th>Capture</th><th>Status</th><th>Created</th><th>Sent</th><th>File</th></tr></thead><tbody>${[...groups].map(([accession, group]) => `<tr class="group"><td colspan="5">${group[0].file_present ? `<a href="#/captures/${esc(pathId(group[0].id))}">${esc(accession)}</a>` : esc(accession)}</td></tr>${group.map(row => `<tr><td>${row.file_present ? linkCapture(row.id) : esc(row.id.slice(0, 8))}</td><td>${esc(row.status)}</td><td>${esc(date(row.created_at))}</td><td>${esc(date(row.sent_at))}</td><td>${esc(row.file_present ? 'on disk' : 'file removed')}</td></tr>`).join('')}`).join('')}</tbody></table>${rows.length ? '' : '<p class="muted">No captures.</p>'}`;
    }
    if (rest.length !== 1) throw new ApiError('Capture page not found', 404);
    const id = rest[0];
    if (!study || study.id !== id) {
      const row = await api(`/captures/${pathId(id)}`);
      const [siblings, config] = await Promise.all([api(`/captures?study_instance_uid=${encodeURIComponent(row.study_instance_uid)}`), api('/system/config')]);
      const items = await Promise.all(siblings.map(async sibling => {
        const item = { row: sibling };
        if (!sibling.file_present) return item;
        const [tags, preview] = await Promise.allSettled([api(`/captures/${pathId(sibling.id)}/tags`), blob(`/captures/${pathId(sibling.id)}/preview`)]);
        if (tags.status === 'fulfilled') item.tags = tags.value;
        if (preview.status === 'fulfilled') item.preview = preview.value.blob;
        const failures = [tags, preview].filter(result => result.status === 'rejected');
        if (failures.some(result => result.reason.status === 401)) throw new ApiError('Sign in again', 401);
        item.missing = failures.some(result => result.reason.status === 404);
        if (failures.length && !item.missing) item.error = failures.map(result => result.reason.message).join(' · ');
        return item;
      }));
      if (version !== routeVersion) return '';
      for (const item of items) if (item.preview && !item.missing) { item.url = objectUrl(item.preview); delete item.preview; }
      study = { id, row, items, store: config.config.store.called_ae, eye: items.some(item => item.tags?.image_laterality === 'R') ? 'R' : items.some(item => item.tags?.image_laterality === 'L') ? 'L' : '' };
    }
    const first = study.items.find(item => item.tags && !item.missing)?.tags;
    const row = study.row, eyes = [['R', 'Right eye'], ['L', 'Left eye']];
    const selected = study.items.filter(item => item.tags?.image_laterality === study.eye || !item.tags || item.missing);
    const delivery = row.sent_at ? `Sent ${time(row.sent_at)} to ${study.store} · ${row.attempts} attempt(s) · ${duration(queueSeconds(row))} in queue` : row.status;
    return `<div class="crumbs"><a href="#/captures">Captures</a> › <b>${esc(row.accession_number)}</b></div><section class="head"><h1>${esc(personName(first?.patient_name) || 'Capture files')}</h1><div class="meta"><span>${esc(first?.patient_id || '—')}</span><span>${esc(date(row.created_at))}</span><span>${esc(study.items.length)} captures</span></div><div class="delivery">${esc(delivery)}</div></section>
      <nav class="tabs" aria-label="Eye">${eyes.map(([eye, label]) => `<button data-action="eye" data-eye="${esc(eye)}" class="${esc(eye === study.eye ? 'on' : '')}" aria-pressed="${esc(eye === study.eye)}">${esc(label)}<small>${esc(study.items.filter(item => item.tags?.image_laterality === eye && !item.missing).length)}</small></button>`).join('')}</nav>
      ${selected.map(captureBlock).join('')}${selected.length ? '' : '<p class="none">No captures for this eye.</p>'}`;
  };

  document.addEventListener('submit', async event => {
    if (event.target.id !== 'signin') return;
    event.preventDefault(); const form = event.target, button = form.querySelector('button'); button.disabled = true;
    try {
      const fields = new FormData(form);
      const response = await fetch('/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: fields.get('email'), password: fields.get('password') }), cache: 'no-store' });
      if (!response.ok) throw new ApiError(response.status === 401 ? 'Invalid email or password' : 'Sign in failed', response.status);
      sessionVersion++; session.save((await response.json()).data); sessionStorage.setItem('signed_in_at', new Date().toISOString()); void render();
    } catch (err) { form.querySelector('.error').textContent = err.message; button.disabled = false; }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    event.preventDefault(); const action = button.dataset.action, version = routeVersion; button.disabled = true;
    try {
      if (action === 'signout') { session.clear(); routeVersion++; signin(); return; }
      if (action === 'sync') { const result = await api('/captures/sync', { method: 'POST' }); if (version !== routeVersion) return; notice = `${result.sent} sent, ${result.failed} failed`; }
      if (action === 'retry') await api(`/captures/${pathId(button.dataset.id)}/retry`, { method: 'POST' });
      if (action === 'release') {
        const reason = button.closest('tr')?.querySelector('select')?.value;
        if (!reason) notice = 'Choose a reason, then release.';
        else if (confirm(`Release the screening for ${button.dataset.accession}? Images already delivered stay in PACS, and the order returns to Patients to Screen.`)) {
          await api(`/screenings/${pathId(button.dataset.id)}/release`, { method: 'POST', body: JSON.stringify({ reason }) });
          if (version !== routeVersion) return;
          notice = `Released ${button.dataset.accession}. The order is back on Patients to Screen.`;
        } else return;
      }
      if (action === 'worklist-support') { await download('/diagnostics/worklist/support'); return; }
      if (action === 'worklist-detail') {
        const report = await api('/diagnostics/worklist');
        if (version === routeVersion) document.getElementById('worklist-result').innerHTML = explanation(report.checks.find(check => check.id === button.dataset.id));
        return;
      }
      if (action === 'worklist-check' || action === 'worklist-preview') {
        const form = document.getElementById('worklist-filters');
        const preview = action === 'worklist-preview';
        if (preview && !form.reportValidity()) return;
        const target = document.getElementById('worklist-result');
        target.innerHTML = '<p role="status">Checking the hospital worklist…</p>';
        const check = await api(`/diagnostics/worklist/${preview ? 'preview' : 'check'}`, { method: 'POST', ...(preview ? { body: JSON.stringify(formFilters(form)) } : {}) });
        if (version === routeVersion) target.innerHTML = explanation(check);
        return;
      }
      if (action === 'worklist-reset') {
        if (!confirm('Restore the filters from the config file loaded at startup? This affects every connected phone.')) return;
        const form = document.getElementById('worklist-filters');
        await api('/diagnostics/worklist/settings/reset', { method: 'POST', body: JSON.stringify({ ...formFilters(form), revision: form.dataset.revision }) });
        if (version !== routeVersion) return;
        notice = 'Config-file filters restored. Refresh the phone.';
      }
      if (action === 'archive') { await download(`/diagnostics/segments/${pathId(button.dataset.id)}/archive`); return; }
      if (action === 'dicom') { await download(`/captures/${pathId(button.dataset.id)}/dicom`); return; }
      if (action === 'recording') {
        try { await api('/diagnostics/recording', { method: 'PUT', body: JSON.stringify({ enabled: button.dataset.enabled === 'true' }) }); }
        catch (err) { if (err.status !== 409) throw err; }
      }
      if (action === 'eye' && study) { study.eye = button.dataset.eye; }
      if (version === routeVersion) await render(false);
    } catch (err) {
      if (version !== routeVersion) return;
      if (err.status === 401) signin(); else { const p = document.createElement('p'); p.className = 'error'; p.setAttribute('role', 'alert'); p.textContent = err.message; root.prepend(p); }
    } finally { button.disabled = false; }
  });
  window.addEventListener('hashchange', () => { void render(); });
  fetch('/health', { cache: 'no-store' }).then(r => r.json()).then(value => { healthCache = value; account(); }).catch(() => {});
  void render();
})();
