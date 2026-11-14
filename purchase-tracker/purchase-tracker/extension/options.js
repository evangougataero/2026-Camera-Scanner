const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function load() {
  const { pt_settings: s } = await chrome.storage.local.get('pt_settings');
  if (s) { $('apiUrl').value = s.apiUrl || ''; $('apiToken').value = s.apiToken || ''; }
  $('scanMetaPay').checked = !s || s.scanMetaPay !== false;            // both default ON
  $('scanNotifications').checked = !s || s.scanNotifications !== false;
  $('fallbackListing').checked = !s || s.fallbackListing !== false;
  await refresh();
}

function msg(text, ok, id) {
  const el = $(id || 'connMsg');
  el.textContent = text;
  el.className = ok ? 'ok' : 'bad';
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

async function refresh() {
  const r = await send({ type: 'pt:status' });
  const st = r.state || {};
  const when = (t) => (t ? new Date(t).toLocaleString() : '—');
  const lines = [
    'Last run started : ' + when(st.lastRunStartedAt),
    'Last run finished: ' + when(st.lastRunFinishedAt) + (st.lastRunOutcome ? '  (' + st.lastRunOutcome + ')' : ''),
    'In progress      : ' + (r.queue ? (r.queue.index + '/' + r.queue.items.length + ' items') : 'no'),
    'Unsent results   : ' + (r.outbox || 0),
    'Last error       : ' + (st.lastError || '—'),
    '',
    ...(st.log || []).slice(-30)
  ];
  $('status').textContent = lines.join('\n');
}

$('save').onclick = async () => {
  const apiUrl = $('apiUrl').value.trim(), apiToken = $('apiToken').value.trim();
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(apiUrl)) return msg('URL must look like https://script.google.com/macros/s/…/exec', false);
  if (!apiToken) return msg('Token is required', false);
  const { pt_settings: prev } = await chrome.storage.local.get('pt_settings');
  await chrome.storage.local.set({ pt_settings: Object.assign({}, prev || {}, { apiUrl, apiToken }) });   // keep the signal settings
  msg('Saved', true);
};

$('saveSignals').onclick = async () => {
  const r = await send({ type: 'pt:saveSignalPrefs', scanMetaPay: $('scanMetaPay').checked, scanNotifications: $('scanNotifications').checked,
    fallbackListing: $('fallbackListing').checked });
  msg(r && r.ok ? 'Saved' : ((r && r.error) || 'Failed'), !!(r && r.ok), 'signalMsg');
};

$('ping').onclick = (e) => busy(e.target, async () => {
  msg('Testing…', true);
  const r = await send({ type: 'pt:ping' });
  r && r.ok ? msg('Connected (server time ' + r.time + ')', true) : msg((r && r.error) || 'Failed', false);
});

$('run').onclick = (e) => busy(e.target, async () => { await send({ type: 'pt:runNow' }); await refresh(); });
$('force').onclick = (e) => busy(e.target, async () => { await send({ type: 'pt:runNow', force: true }); await refresh(); });
$('refresh').onclick = refresh;

const probe = (btnId, outId, type, wait, input) => {
  $(btnId).onclick = (e) => busy(e.target, async () => {
    $(outId).textContent = wait;
    const r = await send(Object.assign({ type }, input ? { input: $(input).value } : {}));
    $(outId).textContent = JSON.stringify(r, null, 2);
  });
};
probe('probeOrders', 'probeOrdersOut', 'pt:probeOrders', 'Opening your Purchased orders page in a background tab… (up to ~4 min)');
probe('probe', 'probeOut', 'pt:probe', 'Opening listing in a background tab… (up to ~2 min)', 'probeInput');
probe('probeSeller', 'probeOut', 'pt:probeSeller', 'Opening listing in a background tab… (up to ~2 min)', 'probeInput');
probe('probeUsps', 'probeUspsOut', 'pt:probeUsps', 'Opening USPS in a background tab… (up to ~90 s)', 'probeUspsInput');
probe('probeMetaPay', 'probeMetaPayOut', 'pt:probeMetaPay', 'Opening Meta Pay wallet in a background tab… (up to ~90 s)');
probe('probeNotifications', 'probeNotificationsOut', 'pt:probeNotifications', 'Opening Marketplace notifications in a background tab… (up to ~2 min)');

setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 10000);
load();
