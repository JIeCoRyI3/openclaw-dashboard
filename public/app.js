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
    // API returns { ok, status }; openclaw gateway status --json outputs the status object
    const s = statusJson?.status ?? statusJson;
    const runtimeState = s?.runtimeState || s?.probe?.state || s?.service?.state || '';
    const probeOk = s?.probe?.ok;
    const loaded = s?.service?.loaded;
    const normalized = String(runtimeState || '').toLowerCase();

    if (probeOk === true || normalized.includes('run') || normalized.includes('active')) {
      return ['running', 'Running'];
    }
    if (normalized.includes('stop') || normalized.includes('dead') || normalized.includes('fail') || loaded === false) {
      return ['stopped', 'Stopped'];
    }
    if (normalized.includes('start') || normalized.includes('init') || normalized.includes('restart')) {
      return ['pending', 'Starting…'];
    }
    return ['unknown', runtimeState || 'Unknown'];
  }

  async function fetchStatus() {
    const res = await fetch('/api/status', { headers: headers() });
    if (res.status === 401) {
      throw new Error('unauthorized');
    }
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
      const res = await fetch(`/api/${action}`, {
        method: 'POST',
        headers: headers()
      });
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
