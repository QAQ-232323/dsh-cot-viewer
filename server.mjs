// 思维链浏览器 · 本地服务
// 读取 ~/.dsh/sessions 下的会话归档，抽出每步 reasoning，提供检索、阅读与翻译。
// 零外部依赖：只用 Node 内置模块（需要 Node ≥ 22.15 以支持 node:zlib 的 zstd）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSessionEvents, foldSession } from './lib/session.mjs';

const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 15)) {
  console.error(`[cot] 需要 Node ≥ 22.15（当前 ${process.versions.node}）。请用 DSH 自带的 node 启动。`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSIONS_ROOT = process.env.COT_SESSIONS_ROOT || path.join(HOME, '.dsh', 'sessions');
const DATA_DIR = path.join(HERE, 'data');
const PUBLIC_DIR = path.join(HERE, 'public');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CACHE_FILE = path.join(DATA_DIR, 'translations.jsonl');
const PORT = Number(process.env.COT_PORT || 7388);
const HOST = process.env.COT_HOST || '127.0.0.1';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- 设置

const DEFAULT_SETTINGS = {
  backend: 'deepseek', // deepseek | ollama
  models: {
    deepseek: 'deepseek-chat',
    ollama: 'qwen2.5:7b-instruct',
  },
  ollamaBaseURL: 'http://127.0.0.1:11434',
  deepseekBaseURL: 'https://api.deepseek.com',
  autoTranslate: true,
  view: 'translated', // original | bilingual | translated
  theme: 'dark',
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

let settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };

// ---------------------------------------------------------------- 凭据

function readDeepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const credFile = path.join(HOME, '.dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(credFile, 'utf8');
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs) {
        if (/^\S/.test(line)) break;
        const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/);
        if (m && m[1] === 'DEEPSEEK_API_KEY') return m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    /* 没有凭据文件 */
  }
  return '';
}

// ---------------------------------------------------------------- 翻译缓存

const translationCache = new Map(); // key -> text
let cacheDirty = false;

function cacheKey(backend, model, hash) {
  return `${backend}:${model}:${hash}`;
}

function loadCache() {
  try {
    const lines = fs.readFileSync(CACHE_FILE, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.k && o.v) translationCache.set(o.k, o.v);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* 首次运行没有缓存 */
  }
}
loadCache();

let cacheFlushTimer = null;
function scheduleCacheFlush() {
  cacheDirty = true;
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(() => {
    cacheFlushTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    const lines = [];
    for (const [k, v] of translationCache) lines.push(JSON.stringify({ k, v }));
    try {
      // 先写临时文件再改名：进程半路被杀时不会留下半截缓存。
      const tmp = CACHE_FILE + '.tmp';
      fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
    } catch (e) {
      console.warn('[cot] 写翻译缓存失败:', e.message);
    }
  }, 1200);
}

function hashText(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- 会话索引

const fileCache = new Map(); // file -> { mtimeMs, size, summary, data, textIndex }

function listSessionFiles() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const wsDir = path.join(SESSIONS_ROOT, d.name);
    let entries = [];
    try {
      entries = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = path.join(wsDir, e.name);
        let files = [];
        try {
          files = fs.readdirSync(sub, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.isFile() && /\.jsonl(\.zstd)?$/.test(f.name)) out.push(path.join(sub, f.name));
        }
      } else if (e.isFile() && /\.jsonl(\.zstd)?$/.test(e.name)) {
        out.push(path.join(wsDir, e.name));
      }
    }
  }
  return out;
}

function sessionIdFor(file) {
  const rel = path.relative(SESSIONS_ROOT, file).split(path.sep).join('/');
  return Buffer.from(rel, 'utf8').toString('base64url');
}
function fileForSessionId(id) {
  const rel = Buffer.from(id, 'base64url').toString('utf8');
  if (rel.includes('..') || path.isAbsolute(rel)) return '';
  const file = path.join(SESSIONS_ROOT, ...rel.split('/'));
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(SESSIONS_ROOT) + path.sep)) return '';
  return resolved;
}

function workspaceFromDir(dirName) {
  const m = dirName.match(/^--(.+)--$/);
  if (!m) return dirName;
  const unescaped = m[1].replace(/~([0-9A-F]{4})~/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return unescaped.replace(/-/g, '\\');
}

function buildSummary(file, st, session) {
  return {
    id: sessionIdFor(file),
    file,
    title: session.title,
    cwd: session.cwd || workspaceFromDir(path.basename(path.dirname(path.dirname(file)))),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    version: session.version,
    model: session.model || '',
    stats: session.stats,
    userCount: session.userCount,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function ensureParsed(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const { events } = readSessionEvents(file);
  const session = foldSession(events, { file });
  // 给每条 reasoning 生成内容指纹；译文在返回时按当前模型补上
  const reasoning = session.reasoning.map((r) => ({ ...r, h: hashText(r.text), zh: '' }));
  const summary = buildSummary(file, st, session);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, summary, session: { ...session, reasoning } };
  fileCache.set(file, entry);
  return entry;
}

/** 按当前翻译后端/模型，把已缓存译文贴回条目。 */
function applyTranslations(session) {
  const models = settings.models || {};
  const model = models[settings.backend] || '';
  for (const r of session.reasoning) {
    r.zh = translationCache.get(cacheKey(settings.backend, model, r.h)) || '';
  }
  return session;
}

function overview() {
  const files = listSessionFiles();
  const sessions = [];
  for (const file of files) {
    try {
      const entry = ensureParsed(file);
      if (entry) sessions.push(entry.summary);
    } catch (err) {
      sessions.push({
        id: sessionIdFor(file),
        file,
        title: `（解析失败）${path.basename(path.dirname(file))}`,
        cwd: '',
        createdAt: 0,
        updatedAt: 0,
        stats: { turns: 0, steps: 0, reasoningCount: 0, reasoningChars: 0, toolCalls: 0 },
        error: String(err && err.message),
        size: 0,
        mtimeMs: 0,
      });
    }
  }
  sessions.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return { sessions, settings: publicSettings(), root: SESSIONS_ROOT };
}

function publicSettings() {
  return {
    ...settings,
    hasDeepseekKey: Boolean(readDeepseekKey()),
  };
}

// ---------------------------------------------------------------- 搜索

function normalizeQuery(q) {
  return q.replace(/\s+/g, ' ').trim();
}

function snippet(text, index, length, radius = 90) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, index),
    hit: text.slice(index, index + length),
    after: text.slice(index + length, end) + (end < text.length ? '…' : ''),
    offset: index,
  };
}

function searchSessions({ q, regex = false, workspace = '', onlyReasoning = true, limit = 200 }) {
  const query = normalizeQuery(q || '');
  if (!query) return { hits: [], total: 0, query };
  let re = null;
  if (regex) {
    try {
      re = new RegExp(query, 'gi');
    } catch (e) {
      return { error: '正则表达式无效：' + e.message, hits: [], total: 0, query };
    }
  }
  const needle = query.toLowerCase();
  const files = listSessionFiles();
  const hits = [];
  let total = 0;
  for (const file of files) {
    let entry;
    try {
      entry = ensureParsed(file);
    } catch {
      continue;
    }
    if (!entry) continue;
    if (workspace && entry.summary.cwd !== workspace) continue;
    const session = entry.session;
    for (const r of session.reasoning) {
      const text = r.text;
      let index = -1;
      let matchLen = 0;
      if (re) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) {
          index = m.index;
          matchLen = m[0].length || 1;
        }
      } else {
        index = text.toLowerCase().indexOf(needle);
        matchLen = query.length;
      }
      if (index < 0) continue;
      total++;
      if (hits.length < limit) {
        hits.push({
          sessionId: entry.summary.id,
          title: entry.summary.title,
          cwd: entry.summary.cwd,
          updatedAt: entry.summary.updatedAt,
          turn: r.turn,
          step: r.step,
          hash: r.h,
          ...snippet(text, index, Math.max(1, matchLen)),
        });
      }
    }
    if (onlyReasoning === false) {
      // 也可搜索用户消息（预留）
    }
  }
  hits.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { hits, total, query, regex };
}

// ---------------------------------------------------------------- 翻译

const SYSTEM_PROMPT = [
  '你是翻译器。把用户给出的「思维链」原文翻译成简体中文。',
  '要求：',
  '1. 只输出译文，不要任何前言、解释、总结、评论，不要加「以下是翻译」字样。',
  '2. 保留原文的段落划分、换行与列表结构；代码、命令、文件路径、变量名、URL、JSON、报错原文保持原样不译。',
  '3. 专业术语用中文常用译法，首次出现可在括号内保留英文原词。',
  '4. 忠实原意，不增删内容，不美化，不把口语改成书面腔。',
].join('\n');

function chunkText(text, max = 4000) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('。', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) parts.push(rest);
  return parts;
}

async function* streamChat({ backend, model, messages, signal }) {
  let url;
  let headers = { 'Content-Type': 'application/json' };
  let body;
  if (backend === 'ollama') {
    const base = settings.ollamaBaseURL.replace(/\/+$/, '');
    url = `${base}/v1/chat/completions`;
    headers.Authorization = 'Bearer ollama';
    body = { model, messages, stream: true, temperature: 0.2 };
  } else {
    const key = readDeepseekKey();
    if (!key) throw new Error('没有找到 DEEPSEEK_API_KEY，请在设置里填写或配置 DSH 凭据');
    const base = settings.deepseekBaseURL.replace(/\/+$/, '');
    url = `${base}/chat/completions`;
    headers.Authorization = `Bearer ${key}`;
    body = { model, messages, stream: true, temperature: 0.3, max_tokens: 8000 };
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`上游 ${res.status}: ${detail.slice(0, 400)}`);
  }
  if (!res.body) throw new Error('上游没有返回流式响应');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = obj.choices?.[0]?.delta?.content
          ?? obj.choices?.[0]?.message?.content
          ?? obj.message?.content
          ?? '';
        if (delta) yield delta;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function translateText({ backend, model, text }) {
  const hash = hashText(text);
  const key = cacheKey(backend, model, hash);
  const cached = translationCache.get(key);
  if (cached) return { cached: true, text: cached, hash };

  const chunks = chunkText(text);
  let out = '';
  for (const part of chunks) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: part },
    ];
    for await (const delta of streamChat({ backend, model, messages })) out += delta;
    if (chunks.length > 1) out += '\n\n';
  }
  out = out.trim();
  if (out) {
    translationCache.set(key, out);
    scheduleCacheFlush();
  }
  return { cached: false, text: out, hash };
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/overview') {
    return sendJson(res, 200, overview());
  }

  if (p === '/api/session') {
    const id = url.searchParams.get('id') || '';
    const file = fileForSessionId(id);
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: '找不到会话文件' });
    try {
      const entry = ensureParsed(file);
      return sendJson(res, 200, {
        summary: entry.summary,
        session: applyTranslations(entry.session),
      });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/search') {
    const q = url.searchParams.get('q') || '';
    const regex = url.searchParams.get('regex') === '1';
    const workspace = url.searchParams.get('workspace') || '';
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
    return sendJson(res, 200, searchSessions({ q, regex, workspace, limit }));
  }

  if (p === '/api/settings') {
    if (req.method === 'GET') return sendJson(res, 200, publicSettings());
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      settings = { ...settings, ...body };
      writeJson(SETTINGS_FILE, settings);
      return sendJson(res, 200, publicSettings());
    }
  }

  if (p === '/api/models') {
    const backend = url.searchParams.get('backend') || settings.backend;
    if (backend === 'ollama') {
      try {
        const base = settings.ollamaBaseURL.replace(/\/+$/, '');
        const r = await fetch(`${base}/api/tags`);
        const data = await r.json();
        const models = (data.models || []).map((m) => m.name);
        return sendJson(res, 200, { models });
      } catch (e) {
        return sendJson(res, 200, { models: [], error: String(e.message || e) });
      }
    }
    return sendJson(res, 200, { models: ['deepseek-chat', 'deepseek-reasoner'] });
  }

  if (p === '/api/translate' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const text = String(body.text || '');
    if (!text.trim()) return sendJson(res, 400, { error: '空文本' });
    const backend = body.backend === 'ollama' ? 'ollama' : 'deepseek';
    const model = body.model || settings.models[backend] || (backend === 'ollama' ? 'qwen2.5:7b-instruct' : 'deepseek-chat');
    const force = Boolean(body.force);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const send = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* 客户端已经断开，别把服务端带崩 */
      }
    };
    const key = cacheKey(backend, model, hashText(text));
    const cached = force ? '' : translationCache.get(key);
    if (cached) {
      send('done', { text: cached, cached: true });
      return res.end();
    }
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      send('start', { backend, model });
      let out = '';
      let partIndex = 0;
      for (const part of chunkText(text)) {
        // 分块翻译：块与块之间补一个空行，否则两段译文会直接粘在一起。
        if (partIndex++ > 0) {
          out += '\n\n';
          send('delta', { text: '\n\n' });
        }
        const messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: part },
        ];
        for await (const delta of streamChat({ backend, model, messages, signal: controller.signal })) {
          out += delta;
          send('delta', { text: delta });
        }
      }
      out = out.trim();
      if (out) {
        translationCache.set(key, out);
        scheduleCacheFlush();
      }
      send('done', { text: out, cached: false });
      res.end();
    } catch (e) {
      if (!controller.signal.aborted) {
        send('error', { error: String(e.message || e) });
        res.end();
      } else {
        res.end();
      }
    }
    return undefined;
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

function openBrowser(url) {
  if (process.env.COT_NO_OPEN) return;
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了 */
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const url = `http://${HOST}:${PORT}`;
    console.log(`[cot] 端口 ${PORT} 已被占用，直接打开现有页面 → ${url}`);
    openBrowser(url);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[cot] 思维链浏览器已启动 → ${url}`);
  console.log(`[cot] 会话目录：${SESSIONS_ROOT}`);
  // 先在后台把索引建好，页面打开时就不用等冷启动
  setTimeout(() => {
    try {
      const t0 = Date.now();
      const data = overview();
      console.log(`[cot] 索引完成：${data.sessions.length} 个会话，用时 ${Date.now() - t0} ms`);
    } catch (e) {
      console.warn('[cot] 预热索引失败：', e.message);
    }
  }, 50);
  setTimeout(() => openBrowser(url), 400);
});

export { server, settings, translationCache };
