(function () {
  const authPanel = document.getElementById('auth-panel');
  const dashboard = document.getElementById('dashboard');
  const authForm = document.getElementById('auth-form');
  const passwordInput = document.getElementById('password');
  const authError = document.getElementById('auth-error');
  const statusIndicator = document.getElementById('status-indicator');
  const statusLabel = document.getElementById('status-label');
  const hint = document.getElementById('hint');
  const controlButtons = document.querySelectorAll('.controls [data-action]');
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');
  const tokensTbody = document.getElementById('tokens-tbody');
  const tokensTotal = document.getElementById('tokens-total');
  const tokensInput = document.getElementById('tokens-input');
  const tokensOutput = document.getElementById('tokens-output');
  const tokensCost = document.getElementById('tokens-cost');

  let password = localStorage.getItem('openclaw-dashboard-password') || '';

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (password) h['X-Dashboard-Password'] = password;
    return h;
  }

  function setStatus(state, label) {
    ['status-running', 'status-stopped', 'status-pending', 'status-unknown'].forEach((c) =>
      statusIndicator.classList.remove(c)
    );
    statusIndicator.classList.add('status-' + (state || 'unknown'));
    statusLabel.textContent = label || '—';
  }

  function deriveStatus(statusJson) {
    const s = statusJson?.status ?? statusJson;
    const rt = s?.service?.runtime;
    const runtimeState =
      rt?.state || rt?.status || rt?.subState ||
      s?.runtimeState || s?.probe?.state || s?.service?.state || '';
    const rpcOk = s?.rpc?.ok;
    const loaded = s?.service?.loaded;
    const portBusy = s?.port?.status === 'busy';
    const normalized = String(runtimeState || '').toLowerCase();

    if (rpcOk === true || portBusy || normalized.includes('run') || normalized.includes('active')) {
      return ['running', 'Running'];
    }
    if (normalized.includes('stop') || normalized.includes('dead') || normalized.includes('fail') || normalized.includes('inactive') || loaded === false) {
      return ['stopped', 'Stopped'];
    }
    if (normalized.includes('start') || normalized.includes('init') || normalized.includes('restart')) {
      return ['pending', 'Starting…'];
    }
    return ['unknown', runtimeState || 'Unknown'];
  }

  async function fetchStatus() {
    const res = await fetch('/api/status', { headers: headers() });
    if (res.status === 401) throw new Error('unauthorized');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to get status');
    return data;
  }

  async function loadStatus() {
    try {
      const data = await fetchStatus();
      const [state, label] = deriveStatus(data);
      setStatus(state, label);
      hint.textContent = '';
    } catch (err) {
      if (err.message === 'unauthorized') throw err;
      setStatus('unknown', 'Error');
      hint.textContent = err.message;
    }
  }

  async function runAction(action) {
    try {
      const res = await fetch(`/api/${action}`, { method: 'POST', headers: headers() });
      if (res.status === 401) throw new Error('unauthorized');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Action failed');
      setStatus('pending', action === 'stop' ? 'Stopping…' : 'Restarting…');
      hint.textContent = '';
      setTimeout(loadStatus, 2000);
    } catch (err) {
      if (err.message === 'unauthorized') throw err;
      hint.textContent = err.message;
    }
  }

  function showAuth() {
    authPanel.classList.remove('hidden');
    dashboard.classList.add('hidden');
  }

  function showDashboard() {
    authPanel.classList.add('hidden');
    dashboard.classList.remove('hidden');
  }

  function setActiveTab(tab) {
    tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    tabContents.forEach((section) => {
      section.classList.toggle('hidden', section.id !== 'tab-' + tab);
    });
    if (tab === 'tokens') loadTokens();
  }

  function formatTime(ts) {
    if (ts == null || ts === '') return '—';
    try {
      const d = new Date(ts);
      const n = d.getTime();
      if (!Number.isFinite(n)) return '—';
      return d.toLocaleString();
    } catch (_) {
      return '—';
    }
  }

  function formatCost(v) {
    const n = Number(v);
    return Number.isFinite(n) ? '$' + n.toFixed(4) : '$0.00';
  }

  function safeToLocaleString(n) {
    const val = Number(n);
    return Number.isFinite(val) ? val.toLocaleString() : '0';
  }

  function truncate(text, max) {
    if (!text) return '';
    return text.length > (max || 120) ? text.slice(0, max || 120) + '…' : text;
  }

  function escapeHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  async function loadTokens() {
    if (!tokensTbody) return;
    try {
      const res = await fetch('/api/tokens', { headers: headers() });
      if (res.status === 401) throw new Error('unauthorized');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to load tokens');
      const { summary = {}, runs = [] } = data;
      const totIn = Number(summary.totalInput) || 0;
      const totOut = Number(summary.totalOutput) || 0;
      tokensTotal.textContent = safeToLocaleString(totIn + totOut);
      tokensInput.textContent = safeToLocaleString(totIn);
      tokensOutput.textContent = safeToLocaleString(totOut);
      tokensCost.textContent = formatCost(summary.totalCost);
      tokensTbody.innerHTML = runs.length
        ? runs.map((r) => {
            const icon = r.runType === 'user' ? '👤' : '🤖';
            const desc = truncate(r.prompt, 150) || '—';
            const tok = (Number(r.tokens?.input) || 0) + (Number(r.tokens?.output) || 0);
            return `<tr>
              <td>${escapeHtml(formatTime(r.timestamp))}</td>
              <td>${icon}</td>
              <td class="prompt-cell" title="${escapeHtml(r.prompt ?? '')}">${escapeHtml(desc)}</td>
              <td>${safeToLocaleString(tok)}</td>
              <td>${formatCost(r.cost)}</td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="5">No runs yet</td></tr>';
    } catch (err) {
      tokensTbody.innerHTML = '<tr><td colspan="5">' + (err.message || 'Error loading tokens') + '</td></tr>';
    }
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    password = passwordInput.value.trim();
    if (!password) return;
    try {
      await loadStatus();
      localStorage.setItem('openclaw-dashboard-password', password);
      passwordInput.value = '';
      showDashboard();
    } catch (err) {
      authError.textContent = err.message === 'unauthorized' ? 'Invalid password' : err.message;
    }
  });

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  controlButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action) runAction(action);
    });
  });

  async function bootstrap() {
    try {
      await loadStatus();
      showDashboard();
    } catch (err) {
      if (err.message === 'unauthorized') {
        showAuth();
      } else {
        showDashboard();
        setStatus('unknown', 'Error');
        hint.textContent = err.message || 'Could not load status';
      }
    }
  }

  bootstrap();
  setInterval(loadStatus, 10000);
})();
