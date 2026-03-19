#!/usr/bin/env node
/**
 * OpenClaw Dashboard Server
 * Manages OpenClaw gateway: status, start, stop, restart.
 * Run on the Linux machine where OpenClaw is installed.
 */

const express = require('express');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Unset OpenClaw service env vars so we run as user, not as service
['OPENCLAW_SERVICE_MARKER', 'OPENCLAW_SERVICE_KIND', 'OPENCLAW_SYSTEMD_UNIT', 'OPENCLAW_WINDOWS_TASK_NAME', 'OPENCLAW_SHELL'].forEach((key) => {
  if (process.env[key]) delete process.env[key];
});

const PORT = process.env.PORT || 3142;
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!PASSWORD || req.headers['x-dashboard-password'] === PASSWORD) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function runOpenclaw(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('openclaw', args, { maxBuffer: 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

function runGatewayActionAsync(args) {
  const child = spawn('openclaw', args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('Gateway action error:', e));
  child.unref();
  return child.pid;
}

app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const stdout = await runOpenclaw(['gateway', 'status', '--json']);
    const status = JSON.parse(stdout);
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/:action', requireAuth, async (req, res) => {
  const { action } = req.params;
  const valid = ['start', 'stop', 'restart'];
  if (!valid.includes(action)) {
    return res.status(400).json({ ok: false, error: 'unknown action' });
  }
  try {
    const pid = runGatewayActionAsync(['gateway', action]);
    res.json({ ok: true, pid });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`OpenClaw Dashboard: http://localhost:${PORT}`);
  if (PASSWORD) console.log('Auth: DASHBOARD_PASSWORD required');
});
