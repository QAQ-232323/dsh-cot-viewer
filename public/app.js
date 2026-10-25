// 思维链浏览器 · 前端
const API_BASE = (document.documentElement.getAttribute('data-api-base') || '/api').replace(/\/+$/, '');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  sessions: [],
  settings: {},
  backend: 'deepseek',
  model: 'deepseek-chat',
  view: 'bilingual',
  auto: true,
  sort: 'recent',
  workspace: '',
  query: '',
  regex: false,
  currentId: '',
  session: null,
  hashes: new Map(), // hash -> Set<element>
  queue: [],
  translating: 0,
  ollamaModels: [],
  searchToken: 0,
  openToken: 0,
};

const els = {
  list: $('#session-list'),
  meta: $('#sidebar-meta'),
  content: $('#content'),
  crumb: $('#crumb'),
  q: $('#q'),
  regex: $('#regex'),
  workspace: $('#workspace-filter'),
  sort: $('#sort-mode'),
  statusLeft: $('#status-left'),
  statusRight: $('#status-right'),
  brandSub: $('#brand-sub'),
  modelSelect: $('#model-select'),
  auto: $('#auto-translate'),
  viewSwitch: $('#view-switch'),
  translateAll: $('#btn-translate-all'),
  exportBtn: $('#btn-export'),
  refresh: $('#btn-refresh'),
  toast: $('#toast'),
};

// ---------------------------------------------------------------- 工具

function escapeText(s) {
  return s == null ? '' : String(s);
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return fmtTime(ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  return fmtTime(ms).slice(0, 10);
}

function fmtNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return String(n);
}

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setStatus(left, right) {
  if (left != null) els.statusLeft.textContent = left;
  if (right != null) els.statusRight.textContent = right;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------- 侧栏

function sortSessions(list) {
  const arr = [...list];
  if (state.sort === 'oldest') arr.sort((a, b) => (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt));
  else if (state.sort === 'biggest') arr.sort((a, b) => (b.stats?.reasoningCount || 0) - (a.stats?.reasoningCount || 0));
  else arr.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return arr;
}

function renderSidebar() {
  const workspaces = [...new Set(state.sessions.map((s) => s.cwd).filter(Boolean))].sort();
  const cur = state.workspace;
  els.workspace.innerHTML = '<option value="">全部工作区</option>';
  for (const w of workspaces) {
    const opt = document.createElement('option');
    opt.value = w;
    opt.textContent = shortenPath(w);
    els.workspace.appendChild(opt);
  }
  els.workspace.value = cur;

  let list = state.sessions;
  if (state.workspace) list = list.filter((s) => s.cwd === state.workspace);
  list = sortSessions(list);

  const totalCount = state.sessions.length;
  const totalReasoning = state.sessions.reduce((n, s) => n + (s.stats?.reasoningCount || 0), 0);
  els.meta.innerHTML = `<span>${totalCount} 个会话 · ${fmtNum(totalReasoning)} 条思考</span><span>${state.workspace ? '已筛选' : ''}</span>`;

  els.list.innerHTML = '';
  if (!list.length) {
    els.list.innerHTML = '<div style="padding:20px;color:var(--text-faint);font-size:12.5px">没有找到会话</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === state.currentId ? ' active' : '');
    item.dataset.id = s.id;
    const title = document.createElement('div');
    title.className = 'si-title';
    title.textContent = s.title || '(无标题)';
    const sub = document.createElement('div');
    sub.className = 'si-sub';
    const badge = document.createElement('span');
    badge.className = 'si-badge';
    badge.textContent = `${s.stats?.reasoningCount || 0} 思考`;
    const when = document.createElement('span');
    when.textContent = fmtAgo(s.updatedAt || s.createdAt);
    sub.append(badge, when);
    item.append(title, sub);
    item.addEventListener('click', () => {
      location.hash = `#/s/${s.id}`;
      closeMobileSidebar();
    });
    frag.appendChild(item);
  }
  els.list.appendChild(frag);
  const emptyCount = $('#empty-count');
  if (emptyCount) emptyCount.textContent = String(totalCount);
}

function shortenPath(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…\\' + parts.slice(-2).join('\\');
}

// ---------------------------------------------------------------- 会话

function reasoningHashMap(session) {
  const map = new Map();
  const counter = new Map();
  for (const r of session.reasoning || []) {
    const k = `${r.turn}:${r.step}`;
    const i = counter.get(k) || 0;
    counter.set(k, i + 1);
    map.set(`${k}:${i}`, r);
  }
  return map;
}

async function openSession(id, focus) {
  state.currentId = id;
  const token = ++state.openToken;
  renderSidebar();
  setStatus('正在打开会话…', '');
  els.content.innerHTML = '<div class="empty-state"><div class="empty-mark">🐋</div><p>正在解压会话…</p></div>';
  try {
    const data = await api(`${API_BASE}/session?id=${encodeURIComponent(id)}`);
    if (token !== state.openToken) return; // 连点两个会话时，慢的那个不许覆盖新的
    state.session = data.session;
    renderSession(data.session, data.summary, focus);
  } catch (e) {
    if (token !== state.openToken) return;
    els.content.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'empty-state';
    box.innerHTML = `<div class="empty-mark">😵</div><h1>打不开这个会话</h1><p></p>`;
    box.querySelector('p').textContent = String(e.message || e);
    els.content.appendChild(box);
    setStatus('打开失败', '');
  }
}

function makeCotBlock(rec) {
  const wrap = document.createElement('article');
  wrap.className = 'cot';
  wrap.dataset.hash = rec.h;
  wrap.dataset.turn = rec.turn;
  wrap.dataset.step = rec.step;

  const head = document.createElement('div');
  head.className = 'cot-head';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = '思考';
  const len = document.createElement('span');
  len.textContent = `${rec.text.length.toLocaleString()} 字`;
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'mini-btn';
  copyBtn.textContent = '复制';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rec.text);
      toast('原文已复制');
    } catch {
      toast('复制失败，浏览器不允许');
    }
  });
  const reBtn = document.createElement('button');
  reBtn.className = 'mini-btn';
  reBtn.textContent = '重译';
  reBtn.addEventListener('click', () => {
    wrap.dataset.forced = '1';
    queueTranslation(wrap, true);
  });
  head.append(tag, len, spacer, copyBtn, reBtn);

  const zh = document.createElement('div');
  zh.className = 'cot-text zh-wrap';
  const zhText = document.createElement('div');
  zhText.className = 'cot-text-inner';
  const zhState = document.createElement('span');
  zhState.className = 'zh-state pending';
  zhState.textContent = '待翻译';
  zhText.appendChild(zhState);
  zh.appendChild(zhText);

  const orig = document.createElement('div');
  orig.className = 'cot-text orig collapsed';
  orig.textContent = rec.text;
  orig.title = '点击展开/收起原文';
  orig.addEventListener('click', () => orig.classList.toggle('collapsed'));

  wrap.append(head, zh, orig);
  if (rec.zh) {
    zhText.textContent = rec.zh;
    wrap.dataset.state = 'done';
  }
  return wrap;
}

function renderSession(session, summary, focus) {
  els.content.innerHTML = '';
  state.hashes = new Map();
  const s = summary;
  const head = document.createElement('div');
  head.className = 'session-head';
  const h1 = document.createElement('h1');
  h1.textContent = s.title || '(无标题会话)';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [
    `开始 ${fmtTime(s.createdAt)}`,
    `最后活动 ${fmtAgo(s.updatedAt)}`,
    `${s.stats.turns} 轮`,
    `${s.stats.reasoningCount} 条思考`,
    `${fmtNum(s.stats.reasoningChars)} 字`,
    `${s.stats.toolCalls} 次工具调用`,
  ];
  if (s.model) bits.push(`模型 ${s.model}`);
  for (const b of bits) {
    const span = document.createElement('span');
    span.textContent = b;
    meta.appendChild(span);
  }
  const ws = document.createElement('span');
  ws.textContent = s.cwd || '';
  ws.title = s.cwd || '';
  meta.appendChild(ws);
  head.append(h1, meta);
  els.content.appendChild(head);

  const turnsBox = document.createElement('div');
  turnsBox.className = 'turns';
  els.content.appendChild(turnsBox);

  const hashMap = reasoningHashMap(session);
  const counters = new Map();
  let firstCot = null;

  for (const t of session.turns || []) {
    const turn = document.createElement('section');
    turn.className = 'turn';
    turn.dataset.turn = t.turn;
    const turnHead = document.createElement('div');
    turnHead.className = 'turn-head';
    const no = document.createElement('div');
    no.className = 'turn-no';
    no.textContent = String(t.turn);
    const user = document.createElement('div');
    user.className = 'turn-user';
    user.textContent = t.userText || '(没有记录到用户输入)';
    if ((t.userText || '').length > 160) {
      user.classList.add('clamped');
      user.addEventListener('click', () => user.classList.toggle('clamped'));
    }
    turnHead.append(no, user);
    turn.appendChild(turnHead);

    for (const st of t.steps || []) {
      const stepEl = document.createElement('div');
      stepEl.className = 'step' + (st.reasoning && st.reasoning.length ? ' has-reasoning' : '');
      const stepHead = document.createElement('div');
      stepHead.className = 'step-head';
      const label = document.createElement('span');
      label.className = 'step-label';
      label.textContent = `第 ${st.step} 步`;
      stepHead.appendChild(label);
      if (st.time) {
        const d = document.createElement('span');
        d.className = 'dot';
        d.textContent = '·';
        const tm = document.createElement('span');
        tm.textContent = new Date(st.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        stepHead.append(d, tm);
      }
      stepEl.appendChild(stepHead);

      for (let i = 0; i < (st.reasoning || []).length; i++) {
        const k = `${t.turn}:${st.step}`;
        const idx = counters.get(k) || 0;
        counters.set(k, idx + 1);
        const rec = hashMap.get(`${k}:${idx}`);
        if (!rec) continue;
        const block = makeCotBlock(rec);
        stepEl.appendChild(block);
        if (!firstCot) firstCot = block;
        if (!state.hashes.has(rec.h)) state.hashes.set(rec.h, new Set());
        state.hashes.get(rec.h).add(block);
      }

      if (st.tools && st.tools.length) {
        const chips = document.createElement('div');
        chips.className = 'tool-chips';
        for (const tool of st.tools) {
          const chip = document.createElement('span');
          chip.className = 'tool-chip';
          chip.textContent = `${tool.name}${tool.args ? ' · ' + tool.args : ''}`;
          chip.title = chip.textContent;
          chips.appendChild(chip);
        }
        stepEl.appendChild(chips);
      }

      if (st.text) {
        const reply = document.createElement('div');
        reply.className = 'reply';
        reply.textContent = st.text;
        stepEl.appendChild(reply);
      }
      turn.appendChild(stepEl);
    }
    turnsBox.appendChild(turn);
  }

  const crumbTitle = document.createElement('span');
  crumbTitle.textContent = s.title || '';
  els.crumb.innerHTML = '';
  els.crumb.append(crumbTitle, Object.assign(document.createElement('small'), { textContent: `${s.cwd || ''} · ${fmtTime(s.createdAt)}` }));

  for (const el of $$('.cot', els.content)) {
    const h = el.dataset.hash;
    if (!state.hashes.has(h)) state.hashes.set(h, new Set());
    state.hashes.get(h).add(el);
  }

  setStatus(`共 ${s.stats.reasoningCount} 条思考，${fmtNum(s.stats.reasoningChars)} 字`, `${s.cwd || ''}`);
  observeVisible();
  if (state.auto && state.view !== 'original') primeAutoTranslate();

  if (focus) {
    requestAnimationFrame(() => scrollToFocus(focus));
  } else if (firstCot) {
    els.content.scrollTop = 0;
  }
}

function scrollToFocus(focus) {
  const { turn, step, hash } = focus;
  let target = null;
  if (hash) target = $(`.cot[data-hash="${CSS.escape(hash)}"]`, els.content);
  if (!target && turn) {
    const turnEl = $(`.turn[data-turn="${turn}"]`, els.content);
    if (turnEl) {
      if (step) {
        const steps = $$('.step', turnEl);
        target = steps[step - 1] || turnEl;
      } else {
        target = turnEl;
      }
    }
  }
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  const cot = target.classList.contains('cot') ? target : target.querySelector('.cot');
  if (cot) {
    cot.classList.add('highlight');
    setTimeout(() => cot.classList.remove('highlight'), 2400);
  }
}

// ---------------------------------------------------------------- 翻译

const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    if (el.dataset.state === 'done' || el.dataset.state === 'translating' || el.dataset.state === 'queued') continue;
    if (!state.auto || state.view === 'original') continue;
    queueTranslation(el, false);
  }
}, { root: els.content, rootMargin: '300px 0px' });

function observeVisible() {
  $$('.cot', els.content).forEach((el) => io.observe(el));
}

function primeAutoTranslate() {
  const blocks = $$('.cot', els.content).slice(0, 3);
  for (const b of blocks) {
    if (b.dataset.state !== 'done') queueTranslation(b, false);
  }
}

/** 把当前视口附近还没翻的块排进队列（切视图 / 打开自动翻译后补一遍）。 */
function queueVisible() {
  if (!state.auto || state.view === 'original') return;
  const root = els.content.getBoundingClientRect();
  for (const el of $$('.cot', els.content)) {
    if (el.dataset.state === 'done' || el.dataset.state === 'translating' || el.dataset.state === 'queued') continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > root.top - 300 && r.top < root.bottom + 300) queueTranslation(el, false);
  }
}

function queueTranslation(el, force) {
  if (el.dataset.state === 'translating') return;
  if (el.dataset.state === 'done' && !force) return;
  if (!force && el.dataset.state === 'queued') return;
  el.dataset.state = 'queued';
  const stateEl = $('.zh-state', el);
  if (stateEl) { stateEl.className = 'zh-state pending'; stateEl.textContent = '排队中'; }
  state.queue.push({ el, force });
  pump();
}

async function pump() {
  while (state.translating < 2 && state.queue.length) {
    const job = state.queue.shift();
    const el = job.el;
    if (!el.isConnected) continue;
    if (el.dataset.state === 'done' && !job.force) continue;
    state.translating++;
    translateOne(el, job.force).finally(() => {
      state.translating--;
      updateProgress();
      pump();
    });
  }
}

function updateProgress() {
  if (state.translating || state.queue.length) {
    const n = state.hashes.size;
    setStatus(`翻译中… 进行 ${state.translating} / 排队 ${state.queue.length}`, `本会话 ${n} 条`);
  } else {
    setStatus('就绪', state.currentId ? `会话 ${state.session?.stats?.reasoningCount ?? ''} 条思考` : '');
  }
}

/** 翻译完成后：写回内存（导出用）、同步所有同 hash 的块。 */
function applyTranslated(hash, text, el, force) {
  el.dataset.state = 'done';
  const inner = $('.cot-text-inner', el);
  if (inner) inner.textContent = text;
  for (const r of state.session?.reasoning || []) {
    if (r.h === hash) r.zh = text;
  }
  const set = state.hashes.get(hash);
  if (set) {
    for (const other of set) {
      if (other === el) continue;
      if (other.dataset.state !== 'done' || force) {
        const t = $('.cot-text-inner', other);
        if (t) t.textContent = text;
        other.dataset.state = 'done';
      }
    }
  }
}

async function translateOne(el, force) {
  const hash = el.dataset.hash;
  const rec = findRec(el);
  if (!rec) return;
  el.dataset.state = 'translating';
  const zhText = $('.cot-text-inner', el);
  const stateEl = $('.zh-state', el);
  if (stateEl) stateEl.remove();
  zhText.textContent = '';
  const spinner = document.createElement('span');
  spinner.className = 'zh-state pending';
  spinner.textContent = '翻译中';
  zhText.appendChild(spinner);

  const controller = new AbortController();
  let reader = null;
  try {
    const res = await fetch(API_BASE + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        text: rec.text,
        backend: state.backend,
        model: state.model,
        force: Boolean(force),
      }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(detail || `HTTP ${res.status}`);
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let acc = '';
    spinner.textContent = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evLine = block.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const ev = evLine ? evLine.slice(6).trim() : 'message';
        let payload = {};
        try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (ev === 'delta') {
          acc += payload.text || '';
          zhText.textContent = acc;
        } else if (ev === 'done') {
          acc = payload.text || acc;
          applyTranslated(hash, acc, el, force);
        } else if (ev === 'error') {
          throw new Error(payload.error || '翻译失败');
        }
      }
    }
    if (!acc.trim()) {
      throw new Error('上游没有返回内容');
    }
    // 流被截断、没收到 done 事件时也别一直卡在「翻译中」
    if (el.dataset.state !== 'done') applyTranslated(hash, acc, el, force);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 主动中止不算失败
    el.dataset.state = 'error';
    zhText.textContent = '';
    const err = document.createElement('span');
    err.className = 'zh-error';
    err.textContent = `翻译失败：${e.message}（点「重译」再试）`;
    zhText.appendChild(err);
  } finally {
    // 出错时也把流关掉，否则上游会继续把整段翻完（白花额度）
    if (reader) {
      try { reader.cancel(); } catch { /* ignore */ }
    }
    updateProgress();
  }
}

function findRec(el) {
  const turn = Number(el.dataset.turn);
  const step = Number(el.dataset.step);
  const hash = el.dataset.hash;
  return (state.session?.reasoning || []).find((r) => r.h === hash && r.turn === turn && r.step === step)
    || (state.session?.reasoning || []).find((r) => r.h === hash);
}

function translateAll() {
  if (!state.session) return;
  const blocks = $$('.cot', els.content).filter((el) => el.dataset.state !== 'done' && el.dataset.state !== 'translating');
  if (!blocks.length) return toast('这个会话已经全部翻译过了');
  const unique = new Map();
  for (const b of blocks) {
    const r = findRec(b);
    if (r && !unique.has(r.h)) unique.set(r.h, r);
  }
  const chars = [...unique.values()].reduce((n, r) => n + r.text.length, 0);
  const backendName = state.backend === 'ollama' ? `本地 ${state.model}` : `DeepSeek ${state.model}`;
  const ok = confirm(
    `将用 ${backendName} 翻译本会话剩下的 ${unique.size} 条思考，约 ${chars.toLocaleString()} 字。\n` +
    `这会消耗上游 API 额度（本地模型不花钱但更慢）。继续吗？`
  );
  if (!ok) return;
  for (const b of blocks) queueTranslation(b, false);
  toast(`已加入队列：${blocks.length} 条`);
}

function exportSession() {
  const s = state.session;
  if (!s) return toast('先打开一个会话');
  const recMap = new Map();
  const counter = new Map();
  for (const r of s.reasoning) {
    const k = `${r.turn}:${r.step}`;
    const i = counter.get(k) || 0;
    counter.set(k, i + 1);
    recMap.set(`${k}:${i}`, r);
  }
  const lines = [];
  lines.push(`# ${s.title || '(无标题会话)'}`, '');
  lines.push(`- 工作区：${s.cwd || '未知'}`);
  lines.push(`- 开始：${fmtTime(s.createdAt)}`);
  lines.push(`- 最后活动：${fmtTime(s.updatedAt)}`);
  lines.push(`- 统计：${s.stats.turns} 轮 / ${s.stats.reasoningCount} 条思考 / ${s.stats.reasoningChars} 字 / ${s.stats.toolCalls} 次工具调用`);
  lines.push('', '---', '');
  for (const t of s.turns || []) {
    lines.push(`## 第 ${t.turn} 轮`, '');
    if (t.userText) {
      lines.push('**主人：**', '', t.userText, '');
    }
    for (const st of t.steps || []) {
      lines.push(`### 第 ${st.step} 步`, '');
      const k = `${t.turn}:${st.step}`;
      for (let i = 0; i < (st.reasoning || []).length; i++) {
        const rec = recMap.get(`${k}:${i}`);
        if (!rec) continue;
        lines.push('**思考（原文）**', '', rec.text, '');
        if (rec.zh) lines.push('**思考（译文）**', '', rec.zh, '');
      }
      if (st.tools && st.tools.length) {
        lines.push('**工具调用**', '');
        for (const tool of st.tools) lines.push(`- \`${tool.name}\` ${tool.args || ''}`);
        lines.push('');
      }
      if (st.text) lines.push('**回复**', '', st.text, '');
    }
    lines.push('---', '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(s.title || 'cot').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('已导出 Markdown');
}

// ---------------------------------------------------------------- 搜索

let searchTimer = null;
els.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = els.q.value.trim();
  state.query = q;
  if (!q) {
    if (state.currentId) location.hash = `#/s/${state.currentId}`;
    else location.hash = '#/';
    return;
  }
  searchTimer = setTimeout(() => {
    location.hash = `#/search?q=${encodeURIComponent(q)}${state.regex ? '&regex=1' : ''}`;
  }, 320);
});

els.regex.addEventListener('change', () => {
  state.regex = els.regex.checked;
  if (state.query) runSearch(state.query);
});

async function runSearch(q) {
  const token = ++state.searchToken;
  els.crumb.innerHTML = '';
  els.crumb.append(Object.assign(document.createElement('span'), { textContent: '搜索结果' }),
    Object.assign(document.createElement('small'), { textContent: `“${q}”` }));
  els.content.innerHTML = '<div class="search-view"><div class="search-head">搜索中…</div></div>';
  setStatus('搜索中…', '');
  try {
    const params = new URLSearchParams({ q, limit: '300' });
    if (state.regex) params.set('regex', '1');
    if (state.workspace) params.set('workspace', state.workspace);
    const data = await api(API_BASE + '/search?' + params);
    if (token !== state.searchToken) return;
    if (data.error) {
      els.content.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'search-view';
      const head = document.createElement('div');
      head.className = 'search-head';
      head.textContent = data.error;
      box.appendChild(head);
      els.content.appendChild(box);
      return;
    }
    renderSearchResults(q, data);
  } catch (e) {
    if (token !== state.searchToken) return;
    els.content.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'search-view';
    box.textContent = '搜索失败：' + e.message;
    els.content.appendChild(box);
  }
}

function renderSearchResults(q, data) {
  els.content.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'search-view';
  const head = document.createElement('div');
  head.className = 'search-head';
  head.innerHTML = `找到 <b>${data.total}</b> 条命中${data.total > data.hits.length ? `，显示前 ${data.hits.length} 条` : ''}`;
  view.appendChild(head);

  if (!data.hits.length) {
    const p = document.createElement('div');
    p.className = 'search-head';
    p.textContent = '没有命中。换个词试试，或者关掉 .* 正则模式。';
    view.appendChild(p);
  }

  for (const h of data.hits) {
    const hit = document.createElement('div');
    hit.className = 'hit';
    const hd = document.createElement('div');
    hd.className = 'hit-head';
    const title = document.createElement('span');
    title.className = 'hit-title';
    title.textContent = h.title || '(无标题)';
    const loc = document.createElement('span');
    loc.textContent = `第 ${h.turn} 轮 · 第 ${h.step} 步`;
    const when = document.createElement('span');
    when.textContent = fmtAgo(h.updatedAt);
    hd.append(title, loc, when);
    const body = document.createElement('div');
    body.className = 'hit-body';
    body.append(document.createTextNode(h.before));
    const mark = document.createElement('mark');
    mark.textContent = h.hit;
    body.append(mark, document.createTextNode(h.after));
    hit.append(hd, body);
    hit.addEventListener('click', () => {
      location.hash = `#/s/${h.sessionId}?t=${h.turn}&s=${h.step}&h=${h.hash}`;
    });
    view.appendChild(hit);
  }
  els.content.appendChild(view);
  setStatus(`搜索“${q}”`, `${data.total} 条命中`);
}

// ---------------------------------------------------------------- 设置

function renderModelSelect() {
  const sel = els.modelSelect;
  sel.innerHTML = '';
  const g1 = document.createElement('optgroup');
  g1.label = 'DeepSeek';
  for (const m of ['deepseek-chat', 'deepseek-reasoner']) {
    const o = document.createElement('option');
    o.value = `deepseek::${m}`;
    o.textContent = `DeepSeek · ${m}`;
    g1.appendChild(o);
  }
  sel.appendChild(g1);
  if (state.ollamaModels.length) {
    const g2 = document.createElement('optgroup');
    g2.label = '本地 Ollama';
    for (const m of state.ollamaModels) {
      const o = document.createElement('option');
      o.value = `ollama::${m}`;
      o.textContent = `本地 · ${m}`;
      g2.appendChild(o);
    }
    sel.appendChild(g2);
  } else {
    const g2 = document.createElement('optgroup');
    g2.label = '本地 Ollama（未连接）';
    const o = document.createElement('option');
    o.value = `ollama::${state.settings.models?.ollama || 'qwen2.5:7b-instruct'}`;
    o.textContent = `本地 · ${state.settings.models?.ollama || 'qwen2.5:7b-instruct'}`;
    g2.appendChild(o);
    sel.appendChild(g2);
  }
  sel.value = `${state.backend}::${state.model}`;
}

async function loadOllamaModels() {
  try {
    const data = await api(API_BASE + '/models?backend=ollama');
    state.ollamaModels = data.models || [];
  } catch {
    state.ollamaModels = [];
  }
  renderModelSelect();
}

async function saveSettings(patch) {
  try {
    const s = await api(API_BASE + '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    state.settings = s;
  } catch (e) {
    toast('设置保存失败：' + e.message);
  }
}

function applySettings(s) {
  state.settings = s;
  state.backend = s.backend || 'deepseek';
  state.model = s.models?.[state.backend] || (state.backend === 'ollama' ? 'qwen2.5:7b-instruct' : 'deepseek-chat');
  state.view = s.view || 'translated';
  state.auto = s.autoTranslate !== false;
  document.documentElement.dataset.view = state.view;
  els.auto.checked = state.auto;
  for (const b of $$('#view-switch button')) b.classList.toggle('active', b.dataset.view === state.view);
  renderModelSelect();
}

// ---------------------------------------------------------------- 路由

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('/s/')) {
    const [pathPart, queryPart] = h.slice(3).split('?');
    const params = new URLSearchParams(queryPart || '');
    return {
      view: 'session',
      id: decodeURIComponent(pathPart),
      focus: {
        turn: params.get('t') ? Number(params.get('t')) : null,
        step: params.get('s') ? Number(params.get('s')) : null,
        hash: params.get('h') || '',
      },
    };
  }
  if (h.startsWith('/search')) {
    const params = new URLSearchParams(h.split('?')[1] || '');
    return { view: 'search', q: params.get('q') || '', regex: params.get('regex') === '1' };
  }
  return { view: 'home' };
}

async function route() {
  const r = parseHash();
  if (r.view === 'session') {
    if (r.id !== state.currentId) await openSession(r.id, r.focus);
    else if (r.focus) scrollToFocus(r.focus);
    return;
  }
  if (r.view === 'search') {
    els.q.value = r.q;
    state.query = r.q;
    state.regex = r.regex;
    els.regex.checked = r.regex;
    await runSearch(r.q);
    return;
  }
  state.currentId = '';
  state.session = null;
  renderSidebar();
  els.crumb.textContent = '选择一个会话';
  els.content.innerHTML = `
    <div class="empty-state">
      <div class="empty-mark">🐋</div>
      <h1>翻一翻鲸娘的脑内小剧场</h1>
      <p>左边挑一个会话，这里会按「轮 → 步」展开每一步的思考。译文自动出现，原文随时可看。</p>
      <div class="empty-hint">Ctrl K 搜遍全部历史思维链 · 共 <b>${state.sessions.length}</b> 个会话</div>
    </div>`;
  setStatus('就绪', '');
}

// ---------------------------------------------------------------- 启动

async function boot() {
  setStatus('正在扫描会话归档…', '');
  els.brandSub.textContent = '扫描中…';
  try {
    const data = await api(API_BASE + '/overview');
    state.sessions = data.sessions || [];
    applySettings(data.settings || {});
    els.brandSub.textContent = `共 ${state.sessions.length} 个会话`;
    renderSidebar();
    setStatus(`已载入 ${state.sessions.length} 个会话`, data.root || '');
    loadOllamaModels();
    route();
  } catch (e) {
    setStatus('加载失败：' + e.message, '');
    els.content.innerHTML = `<div class="empty-state"><div class="empty-mark">😵</div><h1>连不上本地服务</h1><p>${e.message}</p></div>`;
  }
}

// 事件绑定
els.viewSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  state.view = btn.dataset.view;
  document.documentElement.dataset.view = state.view;
  for (const b of $$('#view-switch button')) b.classList.toggle('active', b.dataset.view === state.view);
  saveSettings({ view: state.view });
  if (state.view !== 'original') {
    // 在「原文」里滚过的块，切回译文时不会再有 IntersectionObserver 回调，得主动补一次
    primeAutoTranslate();
    queueVisible();
  }
});

els.auto.addEventListener('change', () => {
  state.auto = els.auto.checked;
  saveSettings({ autoTranslate: state.auto });
  if (state.auto) {
    primeAutoTranslate();
    queueVisible();
  }
});

els.modelSelect.addEventListener('change', () => {
  const [backend, ...rest] = els.modelSelect.value.split('::');
  const model = rest.join('::');
  state.backend = backend;
  state.model = model;
  const models = { ...(state.settings.models || {}), [backend]: model };
  saveSettings({ backend, models });
  toast(`翻译模型：${backend === 'ollama' ? '本地 ' : 'DeepSeek '}${model}`);
});

els.workspace.addEventListener('change', () => {
  state.workspace = els.workspace.value;
  renderSidebar();
  if (state.query) runSearch(state.query);
});

els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  renderSidebar();
});

els.translateAll.addEventListener('click', translateAll);
els.exportBtn.addEventListener('click', exportSession);

els.refresh.addEventListener('click', async () => {
  els.refresh.classList.add('spin');
  try {
    const data = await api(API_BASE + '/overview');
    state.sessions = data.sessions || [];
    renderSidebar();
    toast(`已刷新：${state.sessions.length} 个会话`);
    if (state.currentId) await openSession(state.currentId);
    else route();
  } catch (e) {
    toast('刷新失败：' + e.message);
  } finally {
    setTimeout(() => els.refresh.classList.remove('spin'), 600);
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    els.q.focus();
    els.q.select();
  }
  if (e.key === 'Escape' && document.activeElement === els.q) {
    els.q.value = '';
    els.q.dispatchEvent(new Event('input'));
  }
});

// 小屏侧栏
function closeMobileSidebar() {
  $('#sidebar').classList.remove('open');
}
$('#btn-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

window.addEventListener('hashchange', route);
boot();
