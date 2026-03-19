#!/usr/bin/env node
/**
 * OpenClaw Dashboard Server
 * Manages OpenClaw gateway: status, start, stop, restart.
 * Token usage from session files.
 * Run on the Linux machine where OpenClaw is installed.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

// Unset OpenClaw service env vars so we run as user, not as service
['OPENCLAW_SERVICE_MARKER', 'OPENCLAW_SERVICE_KIND', 'OPENCLAW_SYSTEMD_UNIT', 'OPENCLAW_WINDOWS_TASK_NAME', 'OPENCLAW_SHELL'].forEach((key) => {
  if (process.env[key]) delete process.env[key];
});

const PORT = process.env.PORT || 3142;
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || path.resolve(__dirname, '..', '..');
const SESSION_STORE_PATH = path.join(OPENCLAW_ROOT, 'agents', 'main', 'sessions', 'sessions.json');
const TOKENS_PATH = path.join(OPENCLAW_ROOT, 'workspace', 'skills', 'dashboard', 'data', 'tokens.json');

const MODEL_PRICING = {
  'gpt-5.1-codex': { input: 5 / 1_000_000, output: 15 / 1_000_000 },
  default: { input: 5 / 1_000_000, output: 15 / 1_000_000 }
};

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

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    console.error('loadJson error:', filePath, e.message);
  }
  return fallback;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return { input: 0, output: 0 };
  const input = raw.input ?? raw.inputTokens ?? raw.promptTokens ?? raw.input_tokens ?? raw.prompt_tokens ?? 0;
  const output = raw.output ?? raw.outputTokens ?? raw.completionTokens ?? raw.output_tokens ?? raw.completion_tokens ?? 0;
  return { input: Number(input) || 0, output: Number(output) || 0 };
}

function estimateCost(model, usage) {
  const rates = MODEL_PRICING[model] || MODEL_PRICING.default;
  return Number(((usage.input || 0) * rates.input + (usage.output || 0) * rates.output).toFixed(6));
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((e) => e?.type === 'text' && e.text)
    .map((e) => e.text)
    .join('\n')
    .trim();
}

function extractAssistantSummary(content) {
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((e) => e?.type === 'text' && e.text)
    .map((e) => e.text.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function parseSessionFile(filePath, info) {
  const runs = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    let pendingPrompt = null;
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type !== 'message' || !data.message) continue;
        const msg = data.message;
        const role = msg.role;
        if (role === 'user') {
          const text = extractText(msg.content || []);
          if (text) pendingPrompt = { text, timestamp: data.timestamp };
        } else if (role === 'assistant') {
          const usageRaw = data.usage ?? msg.usage;
          if (!usageRaw) continue;
          const usage = normalizeUsage(usageRaw);
          if (usage.input === 0 && usage.output === 0) continue;
          const model = data.model ?? msg.model ?? info.model ?? 'gpt-5.1-codex';
          const runType = pendingPrompt ? 'user' : 'internal';
          const prompt = pendingPrompt?.text || '';
          const assistantSummary = extractAssistantSummary(msg.content || []);
          runs.push({
            timestamp: new Date(data.timestamp || Date.now()).getTime(),
            runType,
            prompt: runType === 'user' ? prompt : assistantSummary || info.label || info.channel || 'Internal run',
            channel: info.channel,
            sessionId: info.key,
            model,
            tokens: usage,
            cost: estimateCost(model, usage),
            source: info.label || info.key
          });
          pendingPrompt = null;
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error('parseSessionFile error:', filePath, e.message);
  }
  return runs;
}

function loadSessionRuns() {
  if (!fs.existsSync(SESSION_STORE_PATH)) return [];
  const store = loadJson(SESSION_STORE_PATH, {});
  const runs = [];
  for (const [key, session] of Object.entries(store || {})) {
    const filePath = session.sessionFile;
    if (!filePath || !fs.existsSync(filePath)) continue;
    const channel = session.deliveryContext?.channel || session.lastChannel || session.origin?.provider || 'unknown';
    const model = session.model || 'gpt-5.1-codex';
    const label = session.origin?.label || key;
    runs.push(...parseSessionFile(filePath, { channel, key, model, label }));
  }
  return runs;
}

function loadDashboardRuns() {
  const data = loadJson(TOKENS_PATH, { runs: [] });
  return (data.runs || []).map((run) => {
    const usage = run.tokens || { input: 0, output: 0 };
    const model = run.model || 'gpt-5.1-codex';
    return {
      timestamp: new Date(run.timestamp || Date.now()).getTime(),
      runType: 'user',
      prompt: run.prompt || '',
      channel: run.channel || 'dashboard',
      sessionId: run.sessionId || 'dashboard',
      model,
      tokens: { input: usage.input || 0, output: usage.output || 0 },
      cost: estimateCost(model, usage),
      source: 'dashboard'
    };
  });
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

app.get('/api/tokens', requireAuth, (req, res) => {
  try {
    const sessionRuns = loadSessionRuns();
    const dashboardRuns = loadDashboardRuns();
    const runMap = new Map();
    const makeKey = (r) => `${r.sessionId}:${r.timestamp}:${(r.prompt || '').slice(0, 50)}`;
    for (const r of sessionRuns) runMap.set(makeKey(r), r);
    for (const r of dashboardRuns) {
      if (!runMap.has(makeKey(r))) runMap.set(makeKey(r), r);
    }
    const runs = Array.from(runMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const summary = runs.reduce(
      (acc, r) => {
        acc.totalInput += r.tokens.input || 0;
        acc.totalOutput += r.tokens.output || 0;
        acc.totalCost += r.cost || 0;
        return acc;
      },
      { totalInput: 0, totalOutput: 0, totalCost: 0 }
    );
    summary.totalCost = Number(summary.totalCost.toFixed(4));
    res.json({ ok: true, summary, runs });
  } catch (err) {
    console.error('tokens error:', err);
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
