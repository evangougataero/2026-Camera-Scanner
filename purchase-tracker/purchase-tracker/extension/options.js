const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function load() {
  const { pt_settings: s } = await chrome.storage.local.get('pt_settings');
  if (s) { $('apiUrl').value = s.apiUrl || ''; $('apiToken').value = s.apiToken || ''; }
  await refresh();
}

function msg(text, ok) {
  const el = $('connMsg');
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
    'In progress      : ' + (r.queue ? (r.queue.index + '/' + r.queue.items.length + ' listings') : 'no'),
    'Unsent results   : ' + (r.outbox || 0),
    'Last error       : ' + (st.lastError || '—'),
    '',
    ...(st.log || []).slice(-25)
  ];
  $('status').textContent = lines.join('\n');
}

$('save').onclick = async () => {
  const apiUrl = $('apiUrl').value.trim(), apiToken = $('apiToken').value.trim();
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(apiUrl)) return msg('URL must look like https://script.google.com/macros/s/…/exec', false);
  if (!apiToken) return msg('Token is required', false);
  await chrome.storage.local.set({ pt_settings: { apiUrl, apiToken } });
  msg('Saved', true);
};

$('ping').onclick = (e) => busy(e.target, async () => {
  msg('Testing…', true);
  const r = await send({ type: 'pt:ping' });
  r && r.ok ? msg('Connected (server time ' + r.time + ')', true) : msg((r && r.error) || 'Failed', false);
});

$('run').onclick = (e) => busy(e.target, async () => { await send({ type: 'pt:runNow' }); await refresh(); });
$('force').onclick = (e) => busy(e.target, async () => { await send({ type: 'pt:runNow', force: true }); await refresh(); });
$('refresh').onclick = refresh;

$('probe').onclick = (e) => busy(e.target, async () => {
  $('probeOut').textContent = 'Opening listing in a background tab… (up to ~90 s)';
  const r = await send({ type: 'pt:probe', input: $('probeInput').value });
  $('probeOut').textContent = JSON.stringify(r, null, 2);
});

$('probeUsps').onclick = (e) => busy(e.target, async () => {
  $('probeUspsOut').textContent = 'Opening USPS in a background tab… (up to ~90 s)';
  const r = await send({ type: 'pt:probeUsps', input: $('probeUspsInput').value });
  $('probeUspsOut').textContent = JSON.stringify(r, null, 2);
});

setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 10000);
load();
