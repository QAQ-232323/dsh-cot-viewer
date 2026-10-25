// 思维链插件的宿主业务层：读 DSH 会话归档、全文搜索、翻译。
// 与仓库根目录的 server.mjs 同一套逻辑，只是不自己起 HTTP 服务。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSessionEvents, foldSession } from './session.mjs';

const DEFAULT_SETTINGS = {
  backend: 'deepseek',
  models: { deepseek: 'deepseek-chat', ollama: 'qwen2.5:7b-instruct' },
  ollamaBaseURL: 'http://127.0.0.1:11434',
  deepseekBaseURL: 'https://api.deepseek.com',
  autoTranslate: true,
  view: 'translated',
};

const SYSTEM_PROMPT = [
  '你是翻译器。把用户给出的「思维链」原文翻译成简体中文。',
  '要求：',
  '1. 只输出译文，不要任何前言、解释、总结、评论，不要加「以下是翻译」字样。',
  '2. 保留原文的段落划分、换行与列表结构；代码、命令、文件路径、变量名、URL、JSON、报错原文保持原样不译。',
  '3. 专业术语用中文常用译法，首次出现可在括号内保留英文原词。',
  '4. 忠实原意，不增删内容，不美化，不把口语改成书面腔。',
].join('\n');

function hashText(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

function chunkText(text, max = 4000) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('。', max);
    if (cut < max * 0.5) cut = max;
    // 别把代理对（emoji 等）劈成两半：切片后 JSON 里会成孤立代理，上游直接 400。
    // 只有切点正好落在高位代理上才会劈开；落在低位代理上时高位也一起进前一段。
    if (cut > 0) {
      const code = rest.charCodeAt(cut);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) parts.push(rest);
  return parts;
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

function workspaceFromDir(dirName) {
  const m = dirName.match(/^--(.+)--$/);
  if (!m) return dirName;
  return m[1].replace(/~([0-9A-F]{4})~/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/-/g, '\\');
}

export function createCotService(options) {
  const sessionsRoot = options.sessionsRoot;
  const dataDir = options.dataDir;
  const readDeepseekKey = options.readDeepseekKey || (() => '');
  const log = options.log || (() => {});

  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  const cacheFile = path.join(dataDir, 'translations.jsonl');

  let settings = { ...DEFAULT_SETTINGS };
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch {
    /* 首次运行 */
  }

  const translationCache = new Map();
  try {
    for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.k && o.v) translationCache.set(o.k, o.v);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* 无缓存 */
  }

  let flushTimer = null;
  let dirty = false;
  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      const lines = [];
      for (const [k, v] of translationCache) lines.push(JSON.stringify({ k, v }));
      try {
        // 先写临时文件再改名：进程半路被杀时不会留下半截缓存（原来会整份丢）。
        const tmp = cacheFile + '.tmp';
        fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
        fs.renameSync(tmp, cacheFile);
      } catch (e) {
        log('写翻译缓存失败: ' + e.message);
      }
    }, 1200);
  }

  const cacheKey = (backend, model, hash) => `${backend}:${model}:${hash}`;

  // ---------------- 索引 ----------------

  const fileCache = new Map(); // file -> { mtimeMs, size, summary, session }

  function listSessionFiles() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return out;
    }
    for (const d of dirs) {
      const wsDir = path.join(sessionsRoot, d.name);
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
    return Buffer.from(path.relative(sessionsRoot, file).split(path.sep).join('/'), 'utf8').toString('base64url');
  }
  function fileForSessionId(id) {
    const rel = Buffer.from(id, 'base64url').toString('utf8');
    if (rel.includes('..') || path.isAbsolute(rel)) return '';
    const file = path.join(sessionsRoot, ...rel.split('/'));
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(sessionsRoot) + path.sep)) return '';
    return resolved;
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
    const reasoning = session.reasoning.map((r) => ({ ...r, h: hashText(r.text), zh: '' }));
    const entry = { mtimeMs: st.mtimeMs, size: st.size, summary: buildSummary(file, st, session), session: { ...session, reasoning } };
    fileCache.set(file, entry);
    return entry;
  }

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
    return { sessions, settings: publicSettings(), root: sessionsRoot };
  }

  function getSession(id) {
    const file = fileForSessionId(id);
    if (!file || !fs.existsSync(file)) throw new Error('找不到会话文件');
    const entry = ensureParsed(file);
    return { summary: entry.summary, session: applyTranslations(entry.session) };
  }

  function searchSessions({ q, regex = false, workspace = '', limit = 200 }) {
    const query = String(q || '').replace(/\s+/g, ' ').trim();
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
    const hits = [];
    let total = 0;
    for (const file of listSessionFiles()) {
      let entry;
      try {
        entry = ensureParsed(file);
      } catch {
        continue;
      }
      if (!entry) continue;
      if (workspace && entry.summary.cwd !== workspace) continue;
      for (const r of entry.session.reasoning) {
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
    }
    hits.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { hits, total, query, regex };
  }

  function publicSettings() {
    return { ...settings, hasDeepseekKey: Boolean(readDeepseekKey()) };
  }

  function setSettings(patch) {
    settings = { ...settings, ...(patch || {}) };
    try {
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) {
      log('写设置失败: ' + e.message);
    }
    return publicSettings();
  }

  async function listModels(backend) {
    if (backend === 'ollama') {
      try {
        const base = settings.ollamaBaseURL.replace(/\/+$/, '');
        const r = await fetch(`${base}/api/tags`);
        const data = await r.json();
        return { models: (data.models || []).map((m) => m.name) };
      } catch (e) {
        return { models: [], error: String(e.message || e) };
      }
    }
    return { models: ['deepseek-chat', 'deepseek-reasoner'] };
  }

  const UPSTREAM_TIMEOUT_MS = 180_000;

  async function* streamChat({ backend, model, messages, signal }) {
    let url;
    const headers = { 'Content-Type': 'application/json' };
    let body;
    let base;
    if (backend === 'ollama') {
      base = settings.ollamaBaseURL.replace(/\/+$/, '');
      url = `${base}/v1/chat/completions`;
      headers.Authorization = 'Bearer ollama';
      body = { model, messages, stream: true, temperature: 0.2 };
    } else {
      const key = readDeepseekKey();
      if (!key) throw new Error('没有找到 DEEPSEEK_API_KEY，请在 DSH 里配置模型凭据');
      base = settings.deepseekBaseURL.replace(/\/+$/, '');
      url = `${base}/chat/completions`;
      headers.Authorization = `Bearer ${key}`;
      body = { model, messages, stream: true, temperature: 0.3, max_tokens: 8000 };
    }
    // 上游卡住时不能让人对着「翻译中」一直等：180 秒封顶，超时给一句能看懂的话。
    const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined;
    const requestSignal = signal && timeoutSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : (signal || timeoutSignal);
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal });
    } catch (e) {
      const message = e && e.name === 'TimeoutError'
        ? `上游 ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)} 秒没有响应（${base}）`
        : backend === 'ollama'
          ? `连不上本地 Ollama（${base}）：${e && e.message ? e.message : e}`
          : `请求 DeepSeek 失败（${base}）：${e && e.message ? e.message : e}`;
      throw new Error(message);
    }
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
          // 上游把错误塞在流里（限流、超长、鉴权）时不能当没看见，否则只会显示「上游没有返回内容」。
          if (obj && obj.error) {
            const detail = typeof obj.error === 'string' ? obj.error : (obj.error.message || JSON.stringify(obj.error));
            throw new Error('上游返回错误：' + String(detail).slice(0, 300));
          }
          const delta = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content ?? obj.message?.content ?? '';
          if (delta) yield delta;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async function* translateStream({ text, backend, model, force = false, signal }) {
    const clean = String(text || '');
    if (!clean.trim()) throw new Error('空文本');
    const b = backend === 'ollama' ? 'ollama' : 'deepseek';
    const m = model || settings.models[b] || (b === 'ollama' ? 'qwen2.5:7b-instruct' : 'deepseek-chat');
    const key = cacheKey(b, m, hashText(clean));
    const cached = force ? '' : translationCache.get(key);
    if (cached) {
      yield { type: 'done', text: cached, cached: true };
      return;
    }
    let out = '';
    let partIndex = 0;
    for (const part of chunkText(clean)) {
      // 分块翻译：块与块之间补一个空行，否则两段译文会直接粘在一起。
      if (partIndex++ > 0) {
        out += '\n\n';
        yield { type: 'delta', text: '\n\n' };
      }
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: part },
      ];
      for await (const delta of streamChat({ backend: b, model: m, messages, signal })) {
        out += delta;
        yield { type: 'delta', text: delta };
      }
    }
    out = out.trim();
    if (out) {
      translationCache.set(key, out);
      scheduleFlush();
    }
    yield { type: 'done', text: out, cached: false };
  }

  return {
    overview,
    getSession,
    searchSessions,
    getSettings: publicSettings,
    setSettings,
    listModels,
    translateStream,
    fileForSessionId,
    stats: () => ({ files: fileCache.size, translations: translationCache.size }),
  };
}

export { hashText, SYSTEM_PROMPT };
