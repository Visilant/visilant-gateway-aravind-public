'use strict';
const screen = document.getElementById('screen');
const notice = document.getElementById('notice');
const steps = ['This computer', 'Hospital connections', 'Operator account', 'Connect the phone', 'Test & finish'];
let token, state, step = 0, busy = false, checks = [], connections = [], settings;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function message(text) { notice.hidden = !text; notice.textContent = text; if (text) notice.scrollIntoView({ block: 'nearest' }); }
async function api(route, body) {
  const response = await fetch('/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'This step could not finish. Please retry.');
  return result;
}
const field = (name, label, value, options = '') => `<label>${label}<input name="${name}" value="${esc(value)}" ${options} ${state.configured ? 'disabled' : ''}></label>`;
const action = (name, label, primary = false, disabled = false) => `<button type="button" data-action="${name}" class="${primary ? 'primary' : ''}" ${disabled || busy ? 'disabled' : ''}>${label}</button>`;
const rows = list => list.map(c => `<div class="row"><div><strong>${esc(c.name)}</strong><small>${esc(c.detail)}</small></div><span class="badge ${c.ok ? 'ok' : 'warn'}">${c.ok ? 'Ready' : 'Needs attention'}</span></div>`).join('');
function paint() {
  document.getElementById('steps').innerHTML = steps.map((label, i) => `<button type="button" data-step="${i}" ${i === step ? 'aria-current="step"' : ''} ${busy || (!state.configured && i > (settings && connections.length && connections.every(c => c.ok) ? 2 : 1)) ? 'disabled' : ''}><i>${i + 1}</i>${label}</button>`).join('');
  if (state.completed) { home(); return; }
  const head = (title, intro) => `<div class="tag">STEP ${step + 1} OF 5</div><h2 tabindex="-1">${title}</h2><p class="intro">${intro}</p>`;
  if (step === 0) screen.innerHTML = head('Let’s check this computer', 'We’ll check the installed tools, storage and gateway port. Your phone and APK stay as they are.') +
    `<div class="panel"><strong>Prepared for Aravind</strong><p>Everyday settings are filled in. You’ll only need IT’s hospital connection details and a new operator password.</p></div>${rows(checks)}<div class="actions">${action('computer', checks.length ? 'Check again' : 'Check this computer', false)}${action('next', 'Continue', true, !checks.length || checks.some(c => !c.ok))}</div>`;
  if (step === 1) {
    const c = settings || state.config;
    screen.innerHTML = head('Connect to Aravind', 'Confirm the details with hospital IT. Worklist and PACS can use different servers. Defaults below are editable.') +
      `<label class="file-label">Have a prepared site file?<input type="file" id="import" accept=".json,application/json" ${state.configured ? 'disabled' : ''}></label>
      <form id="hospital"><h3>Centre</h3><div class="grid">${field('centre_code', 'Centre code', c.centre_code, 'required maxlength="64"')}${field('listen_port', 'Gateway port', c.listen_port, 'required type="number" min="1" max="65535"')}</div>
      ${['mwl','store'].map(n => `<h3>${n === 'mwl' ? 'Patient worklist' : 'Image archive (PACS)'}</h3><div class="grid">${field(n+'.host', 'Server address', c[n].host, 'required placeholder="From hospital IT"')}${field(n+'.port', 'Server port', c[n].port, 'required type="number" min="1" max="65535"')}${field(n+'.called_ae', 'Hospital AE title', c[n].called_ae, 'required maxlength="16" placeholder="From hospital IT"')}${field(n+'.calling_ae', 'Gateway AE title', c[n].calling_ae, 'required maxlength="16"')}</div>`).join('')}
      <h3>Worklist & identifiers</h3><div class="grid">${field('mwl.requested_procedure_id', 'Procedure ID (optional)', c.mwl.requested_procedure_id, 'maxlength="16" placeholder="All procedures"')}${field('study_uid_root', 'Approved DICOM UID root', c.study_uid_root, 'required maxlength="40" placeholder="Visilant UID root"')}</div>
      <details><summary>Advanced settings · defaults are ready</summary><div class="grid">${field('mwl.modality', 'Modality filter (optional)', c.mwl.modality, 'maxlength="16" placeholder="All modalities"')}${field('mwl.scheduled_station_ae', 'Station filter (optional)', c.mwl.scheduled_station_ae, 'maxlength="16" placeholder="All stations"')}
      <label>After PACS accepts an image<select name="retention" ${state.configured ? 'disabled' : ''}><option value="KEEP" ${c.retention === 'KEEP' ? 'selected' : ''}>Keep the most recent sent images</option><option value="DELETE_ON_SENT" ${c.retention === 'DELETE_ON_SENT' ? 'selected' : ''}>Delete sent images</option></select></label>${field('retention_keep_count', 'Sent images to keep', c.retention_keep_count, 'required type="number" min="1"')}</div><p class="hint">Default: keep 10 sent images. Waiting images remain queued. Retry every 30 seconds. Storage stays in the gateway data folder.</p></details>
      </form>${rows(connections)}<div class="actions">${action('save', state.configured ? 'Test connections again' : 'Save & test connections')}${action('next', 'Continue', true, !state.configured && (!connections.length || connections.some(c => !c.ok)))}</div>`;
  }
  if (step === 2) screen.innerHTML = head('Create the first account', 'Use this account on the existing phone login screen. Keep the password in your agreed secure place.') +
    (state.configured ? `<div class="panel">The account and settings are saved. Use the account you created; setup will never replace its password.</div><div class="actions">${action('next','Connect the phone',true)}</div>` :
    `<form id="account"><div class="grid"><label>Account name<input name="username" value="aravind.operator" required pattern="[a-zA-Z0-9._-]{2,64}" autocomplete="username"></label><label>Operator email<input name="email" type="email" required autocomplete="email" placeholder="Operator’s email address"></label></div><label>New password<input name="password" type="password" required minlength="12" autocomplete="new-password"></label><p class="hint">At least 12 characters, up to 72 UTF-8 bytes. This first account can also administer the gateway.</p><label>Confirm password<input name="confirm" type="password" required minlength="12" autocomplete="new-password"></label><div class="actions"><span class="hint">The password is never saved in the browser.</span>${action('activate','Save & start gateway',true)}</div></form>`);
  if (step === 3) screen.innerHTML = head('Connect the phone', 'Open InSight-Gateway on the phone. Use the same hospital network as this computer.') +
    `<div class="panel"><strong>Gateway address for the phone</strong>${state.addresses.length ? state.addresses.map(a => `<code class="address">${esc(a)}</code>`).join('') : '<p>No network address found. Connect this computer to the hospital network and refresh.</p>'}<small>${state.addresses.length > 1 ? 'More than one network was found. Ask IT which address the phone can reach.' : 'Ask IT to reserve this address so it stays the same after a restart.'} Do not use localhost on the phone.</small></div><ol><li>Enter the gateway address shown above.</li><li>Sign in with the account you just created.</li><li>Refresh <strong>Patients to Screen</strong> and confirm the synthetic order appears.</li></ol>${rows([{name:'Network sign-in',ok:!!state.progress?.phone_signin_at,detail:'Detected when a client outside this computer successfully signs in. Confirm this is your phone.'},{name:'Worklist fetched',ok:!!state.progress?.worklist_at,detail:'Detected when a network client successfully refreshes the patient list.'}])}<div class="actions">${action('refresh','Check again')}${action('next','Test a screening',true,!state.progress?.phone_signin_at || !state.progress?.worklist_at)}</div>`;
  if (step === 4) {
    const p = state.progress || {};
    screen.innerHTML = head('One test, then you’re ready', 'Use a synthetic patient arranged by Aravind IT. Capture and submit a test screening, then check it in the PACS viewer.') +
      rows([{name:'Images received by gateway',ok:p.received > 0,detail:`${p.received || 0} received since setup began.`},{name:'Images accepted by PACS',ok:p.sent > 0 && !p.waiting && !p.failed,detail:`${p.sent || 0} sent · ${p.waiting || 0} waiting · ${p.failed || 0} need attention. Gateway receipt alone does not confirm PACS delivery.`},{name:'Automatic startup',ok:state.managed_startup && state.reboot_observed,detail:state.managed_startup ? (state.reboot_observed ? 'A computer restart was observed after setup was saved.' : 'Startup task installed. Restart this computer and reopen the Gateway Setup shortcut to verify it.') : 'Use the Windows installer for unattended startup, or ask IT to arrange and verify a supervisor.'}])+
      `<form id="finish"><label class="check"><input type="checkbox" name="synthetic" required>The test used only synthetic patient data, and the expected order appeared on the phone.</label><label class="check"><input type="checkbox" name="viewer" required>Aravind confirmed the test images are visible in the correct study in the PACS viewer.</label><label class="check"><input type="checkbox" name="startup" required>We restarted this computer and verified the gateway started automatically and the phone reconnected.</label></form><div class="actions">${action('refresh','Check again')}${action('finish','Finish setup',true,!p.phone_signin_at || !p.worklist_at || !p.sent || !!p.waiting || !!p.failed || (state.managed_startup && !state.reboot_observed))}</div>`;
  }
}
function home() {
  const p = state.progress, h = state.health;
  screen.innerHTML = `<div class="success" aria-hidden="true">✓</div><div class="tag">SETUP SAVED</div><h2>Your gateway is ready</h2><p class="intro">Use the phone for everyday screenings. The gateway keeps your settings between restarts.</p>${rows([{name:'Gateway',ok:!!p,detail:p ? 'Running. Open the dashboard to check current connections and queued images.' : 'Starting or recovering. Check again shortly.'},{name:'Worklist connection',ok:!!h?.worklist,detail:h?.worklist ? 'Connected' : 'Unavailable. Ask IT to check the worklist server.'},{name:'PACS connection',ok:!!h?.pacs,detail:h?.pacs ? 'Connected' : 'Unavailable. Images remain queued for retry.'},{name:'Images waiting to send',ok:!!h && !h.waiting && !h.failed,detail:h ? `${h.waiting} waiting · ${h.failed} need attention` : 'Waiting for the gateway.'}])}<div class="panel"><strong>Phone gateway address</strong>${state.addresses.map(a => `<code class="address">${esc(a)}</code>`).join('')}</div><div class="actions"><a class="button primary" href="http://127.0.0.1:${Number(state.config.listen_port)}/ui">Open gateway dashboard</a><a class="button" href="/api/support" download>Support report</a></div>`;
}
function readHospital() {
  const form = document.getElementById('hospital');
  if (!form.reportValidity()) return null;
  const data = structuredClone(settings || state.config);
  for (const [name,value] of new FormData(form)) {
    const parts = name.split('.'), numeric = ['listen_port','port','retention_keep_count'].includes(parts.at(-1));
    const object = parts.length === 2 ? data[parts[0]] : data;
    if (!value && parts.length === 2) delete object[parts[1]];
    else object[parts.at(-1)] = numeric ? Number(value) : value.trim();
  }
  return data;
}
async function run(fn) {
  if (busy) return; busy = true; message('');
  screen.inert = true; screen.setAttribute('aria-busy', 'true');
  const buttons = [...document.querySelectorAll('button')].map(b => [b, b.disabled]);
  buttons.forEach(([b]) => b.disabled = true);
  try { await fn(); } catch(error) { message(error.message || 'Unable to connect. Please retry.'); }
  finally { busy = false; screen.inert = false; screen.setAttribute('aria-busy', 'false'); buttons.forEach(([b, disabled]) => { if (b.isConnected) b.disabled = disabled; }); }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled || busy) return;
  if (button.dataset.step !== undefined) { step = Number(button.dataset.step); paint(); return; }
  await run(async () => {
    switch(button.dataset.action) {
      case 'computer': checks = await api('computer',{}); busy = false; paint(); break;
      case 'next': step++; busy = false; paint(); screen.querySelector('h2')?.focus(); break;
      case 'save': {
        if (!state.configured) { const config = readHospital(); if (!config) return; state = await api('draft',config); settings = state.config; }
        connections = await api('connections',{}); busy = false; paint(); break;
      }
      case 'activate': {
        const form = document.getElementById('account'); if (!form.reportValidity()) return;
        const data = Object.fromEntries(new FormData(form)); if (data.password !== data.confirm) throw new Error('The passwords do not match.');
        await api('activate',{email:data.email,username:data.username,password:data.password});
        form.reset(); state = await api('status'); step = 3; busy = false; paint(); break;
      }
      case 'refresh': state = await api('status'); busy = false; paint(); break;
      case 'finish': {
        const form = document.getElementById('finish'); if (!form.reportValidity()) return;
        // Send what the operator actually ticked. The gateway names any unticked item.
        state = await api('finish',{synthetic:form.elements.synthetic.checked,viewer:form.elements.viewer.checked,startup:form.elements.startup.checked}); busy = false; paint(); break;
      }
    }
  });
});
document.addEventListener('submit', event => event.preventDefault());
document.addEventListener('input', event => {
  if (event.target.closest('#hospital')) { connections = []; const next = screen.querySelector('[data-action="next"]'); if (next) next.disabled = true; }
});
document.addEventListener('change', event => {
  if (event.target.id !== 'import') return;
  const file = event.target.files[0]; if (!file) return;
  void run(async () => { if (file.size > 32768) throw new Error('The site file is too large. Choose the prepared JSON configuration.');
    let config; try { config = JSON.parse(await file.text()); } catch { throw new Error('This is not a valid JSON site file.'); }
    state = await api('draft',config); settings = state.config; connections = []; busy = false; paint();
  });
});
(async () => {
  try { token = (await api('session')).token; state = await api('status'); settings = state.configured ? state.config : (state.config.centre_code && state.config.mwl.host ? state.config : undefined); step = state.configured ? 3 : settings ? 1 : 0; paint(); }
  catch { message('Unable to open setup. Start the gateway launcher and reload this page.'); }
})();

setInterval(async () => {
  if (!state || busy || (!state.completed && step !== 3)) return;
  try { const latest = await api('status'); if (busy || (!state.completed && step !== 3)) return; state = latest; paint(); } catch { /* Keep saved progress; Check again offers an explicit retry. */ }
}, 10000);
