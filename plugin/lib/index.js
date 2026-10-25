/**
 * @cetacea/dsh-cot-viewer —— 宿主半边：把思维链浏览器挂进 DSH。
 *
 * 路由（都挂在 /dsh-cot 下）：
 *   GET  /dsh-cot/api/overview          会话清单 + 设置
 *   GET  /dsh-cot/api/session?id=       一个会话的完整结构（含 reasoning 与已缓存译文）
 *   GET  /dsh-cot/api/search?q=         全库搜索思维链
 *   GET  /dsh-cot/api/settings          读设置
 *   POST /dsh-cot/api/settings          写设置
 *   GET  /dsh-cot/api/models?backend=   可用翻译模型
 *   POST /dsh-cot/api/translate         SSE 流式翻译
 *   GET  /dsh-cot/ui/*                 面板页面（iframe 用）
 *
 * 访问控制：
 *   1) Host 必须是本机回环；
 *   2) API 要求 X-Cot-Client: 1（同源页面能带，跨域网页带它要过 CORS 预检，本服务不发 CORS）。
 * 没有用 connection.requestRejection：它按 DSH 自己的客户端凭据判定，面板页面的同源 fetch 没有那份凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCotService } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, '..', 'ui');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS_ROOT = process.env.COT_SESSIONS_ROOT || path.join(DSH_HOME, 'sessions');
const DATA_DIR = path.join(DSH_HOME, 'cot-viewer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readDeepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const text = fs.readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8');
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

function json(res, code, obj) {
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

function hostIsLoopback(req) {
  const host = String(req.headers?.host || '').toLowerCase();
  const name = host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function mount(ctx, log) {
  const service = createCotService({
    sessionsRoot: SESSIONS_ROOT,
    dataDir: DATA_DIR,
    readDeepseekKey,
    log,
  });

  function apiRejected(req, res) {
    if (!hostIsLoopback(req)) {
      json(res, 403, { error: '只接受本机回环访问' });
      return true;
    }
    if (req.headers['x-cot-client'] !== '1') {
      json(res, 403, { error: '缺少 X-Cot-Client 头' });
      return true;
    }
    return false;
  }

  function serveStatic(req, res, relPath) {
    if (!hostIsLoopback(req)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(relPath);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad path');
      return;
    }
    if (rel === '' || rel === '/') rel = '/index.html';
    const resolved = path.resolve(path.join(UI_DIR, rel));
    if (!resolved.startsWith(path.resolve(UI_DIR) + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  async function handleApi(req, res, url) {
    if (apiRejected(req, res)) return;
    const p = url.pathname.replace(/^\/dsh-cot\/api/, '') || '/';
    try {
      if (p === '/overview') return json(res, 200, service.overview());

      if (p === '/session') {
        const id = url.searchParams.get('id') || '';
        return json(res, 200, service.getSession(id));
      }

      if (p === '/search') {
        const rawLimit = Number(url.searchParams.get('limit'));
        return json(res, 200, service.searchSessions({
          q: url.searchParams.get('q') || '',
          regex: url.searchParams.get('regex') === '1',
          workspace: url.searchParams.get('workspace') || '',
          limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200,
        }));
      }

      if (p === '/settings') {
        if (req.method === 'GET') return json(res, 200, service.getSettings());
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          return json(res, 200, service.setSettings(body));
        }
        return json(res, 405, { error: 'method not allowed' });
      }

      if (p === '/models') {
        return json(res, 200, await service.listModels(url.searchParams.get('backend') || ''));
      }

      if (p === '/ping') return json(res, 200, { ok: true, stats: service.stats() });

      if (p === '/translate' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
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
            /* 客户端已经断开，别把宿主带崩 */
          }
        };
        const controller = new AbortController();
        req.on('close', () => controller.abort());
        res.on('error', () => controller.abort());
        try {
          send('start', { backend: body.backend, model: body.model });
          for await (const ev of service.translateStream({
            text: body.text,
            backend: body.backend,
            model: body.model,
            force: Boolean(body.force),
            signal: controller.signal,
          })) {
            if (ev.type === 'delta') send('delta', { text: ev.text });
            else if (ev.type === 'done') send('done', { text: ev.text, cached: ev.cached });
          }
        } catch (e) {
          if (!controller.signal.aborted) send('error', { error: String(e.message || e) });
        }
        res.end();
        return undefined;
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) {
        return json(res, e instanceof SyntaxError ? 400 : 500, { error: String(e.message || e) });
      }
      try { res.end(); } catch { /* ignore */ }
      return undefined;
    }
  }

  const disposer = ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-cot',
    handler: async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname.startsWith('/dsh-cot/api')) return handleApi(req, res, url);
      if (url.pathname === '/dsh-cot' || url.pathname === '/dsh-cot/') {
        res.writeHead(302, { Location: '/dsh-cot/ui/' });
        return res.end();
      }
      // 少一个斜杠时，页面里的相对资源（style.css / app.js）会被解析到 /dsh-cot/ 下 → 404。
      if (url.pathname === '/dsh-cot/ui') {
        res.writeHead(302, { Location: '/dsh-cot/ui/' });
        return res.end();
      }
      if (url.pathname.startsWith('/dsh-cot/ui')) {
        return serveStatic(req, res, url.pathname.slice('/dsh-cot/ui'.length));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return undefined;
    },
  });

  ctx.effect(() => () => disposer(), 'dsh-cot-viewer: routes');
  log(`已挂载 /dsh-cot ← ${SESSIONS_ROOT}`);
}

export default {
  name: '@cetacea/dsh-cot-viewer',
  inject: ['webServer'],

  apply(ctx) {
    const log = (msg) => {
      try {
        ctx.logger?.info?.(`[cot-viewer] ${msg}`);
      } catch {
        console.log(`[cot-viewer] ${msg}`);
      }
    };
    try {
      mount(ctx, log);
    } catch (e) {
      // 插件坏了也不能拖垮 DSH：只记日志，界面照常。
      log('初始化失败：' + (e && e.message ? e.message : String(e)));
    }
  },
};
