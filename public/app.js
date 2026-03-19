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
    const errMsg = s?._error || (s?._parseError ? (s?._error || 'Invalid status') : null);
    if (errMsg) {
      return ['unknown', 'Error', errMsg];
    }
    const rt = s?.service?.runtime;
    const runtimeState =
      rt?.state || rt?.status || rt?.subState ||
      s?.runtimeState || s?.probe?.state || s?.service?.state || '';
    const rpcOk = s?.rpc?.ok;
    const loaded = s?.service?.loaded;
    const portBusy = s?.port?.status === 'busy';
    const normalized = String(runtimeState || '').toLowerCase();

    if (rpcOk === true || portBusy || normalized.includes('run') || normalized.includes('active')) {
      return ['running', 'Running', ''];
    }
    if (normalized.includes('stop') || normalized.includes('dead') || normalized.includes('fail') || normalized.includes('inactive') || loaded === false) {
      return ['stopped', 'Stopped', ''];
    }
    if (normalized.includes('start') || normalized.includes('init') || normalized.includes('restart')) {
      return ['pending', 'Starting…', ''];
    }
    return ['unknown', runtimeState || 'Unknown', ''];
  }

  function isHtmlResponse(text, contentType) {
    const ct = (contentType || '').toLowerCase();
    return ct.includes('text/html') || (text && text.trimStart().startsWith('<') && text.includes('</'));
  }

  function errorFor5xxOrHtml(status, text, contentType) {
    if (status >= 500) {
      return `Gateway temporarily unavailable (HTTP ${status}). Try again in a moment.`;
    }
    if (status >= 400) {
      return `Request failed (${status}). Try again.`;
    }
    return 'Invalid response from server';
  }

  async function parseJsonResponse(res) {
    const text = await res.text();
    const ct = res.headers.get('Content-Type') || '';
    try {
      return JSON.parse(text);
    } catch (_) {
      if (isHtmlResponse(text, ct)) {
        throw new Error(errorFor5xxOrHtml(res.status, text, ct));
      }
      if (!res.ok) {
        const msg = res.status >= 500
          ? `Gateway temporarily unavailable (HTTP ${res.status}). Try again in a moment.`
          : (res.statusText || `Request failed (${res.status})`);
        throw new Error(msg);
      }
      throw new Error('Invalid response from server');
    }
  }

  async function fetchStatus() {
    const res = await fetch('/api/status', { headers: headers() });
    if (res.status === 401) throw new Error('unauthorized');
    if (!res.ok) {
      try {
        const data = await parseJsonResponse(res);
        throw new Error(data?.error || res.statusText || `Request failed (${res.status})`);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
        throw new Error(res.statusText || `Request failed (${res.status})`);
      }
    }
    const data = await parseJsonResponse(res);
    if (!data.ok) throw new Error(data.error || 'Failed to get status');
    return data;
  }

  async function loadStatus() {
    try {
      const data = await fetchStatus();
      const [state, label, errHint] = deriveStatus(data);
      setStatus(state, label);
      setHint(errHint || '', Boolean(errHint));
    } catch (err) {
      if (err.message === 'unauthorized') throw err;
      setStatus('unknown', 'Error');
      setHint(err.message, true);
    }
  }

  function setHint(msg, isError) {
    hint.textContent = msg || '';
    hint.classList.toggle('hint--error', Boolean(isError && msg));
  }

  async function runAction(action) {
    const maxRetries = 3;
    const retryDelays = [1000, 2000, 4000];
    let lastErr = null;

    const setButtonsDisabled = (disabled) => {
      controlButtons.forEach((btn) => { btn.disabled = disabled; });
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          setHint(`Retrying… (${attempt}/${maxRetries})`, false);
          setButtonsDisabled(true);
          await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
        }
        const res = await fetch(`/api/${action}`, { method: 'POST', headers: headers() });
        if (res.status === 401) throw new Error('unauthorized');
        if (!res.ok) {
          try {
            const data = await parseJsonResponse(res);
            throw new Error(data?.error || res.statusText || `Request failed (${res.status})`);
          } catch (e) {
            if (e instanceof Error && e.message) lastErr = e;
            else lastErr = new Error(res.statusText || `Request failed (${res.status})`);
            if (res.status >= 500 && attempt < maxRetries) continue;
            throw lastErr;
          }
        }
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Action failed');
        const pendingLabel = action === 'stop' ? 'Stopping…' : (action === 'start' ? 'Starting…' : 'Restarting…');
        setStatus('pending', pendingLabel);
        setHint('');
        setButtonsDisabled(false);
        pollStatusUntilStable();
        return;
      } catch (err) {
        if (err.message === 'unauthorized') {
          setButtonsDisabled(false);
          throw err;
        }
        lastErr = err;
        if (err.message && attempt < maxRetries) {
          const is5xx = /\(5\d{2}\)|Gateway temporarily unavailable/i.test(err.message);
          if (is5xx) continue;
        }
        setButtonsDisabled(false);
        setHint(err.message, true);
        return;
      }
    }
    setButtonsDisabled(false);
    setHint(lastErr?.message || 'Action failed', true);
  }

  function pollStatusUntilStable() {
    const maxAttempts = 15;
    let attempts = 0;
    function poll() {
      attempts += 1;
      loadStatus().then(() => {
        if (attempts < maxAttempts) {
          const state = statusIndicator.classList.contains('status-running') ||
            statusIndicator.classList.contains('status-stopped');
          if (!state) setTimeout(poll, 2000);
        }
      }).catch(() => {
        if (attempts < maxAttempts) setTimeout(poll, 2000);
      });
    }
    setTimeout(poll, 2000);
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
      const n = typeof ts === 'number' ? ts : Number(ts);
      if (!Number.isFinite(n) || n <= 0) return '—';
      const d = new Date(n);
      const t = d.getTime();
      if (!Number.isFinite(t)) return '—';
      let s;
      try {
        s = d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' });
      } catch (_) {
        s = d.toISOString ? d.toISOString() : String(d);
      }
      return s && s !== 'Invalid Date' ? s : '—';
    } catch (_) {
      return '—';
    }
  }

  function formatCost(v) {
    try {
      const n = Number(v);
      return Number.isFinite(n) ? '$' + n.toFixed(4) : '$0.00';
    } catch (_) {
      return '$0.00';
    }
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

  function renderRunRow(r) {
    try {
      const icon = r?.runType === 'internal' ? '🤖' : '👤';
      const desc = truncate(String(r?.prompt ?? ''), 150) || '—';
      const tok = (Number(r?.tokens?.input) || 0) + (Number(r?.tokens?.output) || 0);
      const timeStr = formatTime(r?.timestamp);
      const costStr = formatCost(r?.cost);
      return `<tr>
        <td>${escapeHtml(timeStr)}</td>
        <td>${icon}</td>
        <td class="prompt-cell" title="${escapeHtml(String(r?.prompt ?? ''))}">${escapeHtml(desc)}</td>
        <td>${safeToLocaleString(tok)}</td>
        <td>${costStr}</td>
      </tr>`;
    } catch (_) {
      return '<tr><td colspan="5">—</td></tr>';
    }
  }

  async function loadTokens() {
    if (!tokensTbody) return;
    try {
      const res = await fetch('/api/tokens', { headers: headers() });
      if (res.status === 401) throw new Error('unauthorized');
      let data;
      try {
        data = await parseJsonResponse(res);
      } catch (e) {
        throw e instanceof Error ? e : new Error('Invalid response');
      }
      if (!data.ok) throw new Error(data.error || 'Failed to load tokens');
      const summary = data.summary || {};
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const totIn = Number(summary.totalInput) || 0;
      const totOut = Number(summary.totalOutput) || 0;
      tokensTotal.textContent = safeToLocaleString(totIn + totOut);
      tokensInput.textContent = safeToLocaleString(totIn);
      tokensOutput.textContent = safeToLocaleString(totOut);
      tokensCost.textContent = formatCost(summary.totalCost);
      tokensTbody.innerHTML = runs.length
        ? runs.map((r) => renderRunRow(r)).join('')
        : '<tr><td colspan="5">No runs yet</td></tr>';
    } catch (err) {
      tokensTbody.innerHTML = '<tr><td colspan="5">' + escapeHtml(String(err?.message || 'Error loading tokens')) + '</td></tr>';
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
        setHint(err.message || 'Could not load status', true);
      }
    }
  }

  bootstrap();
  setInterval(loadStatus, 10000);
})();
