// 思维链解析库：读取 DSH 会话归档（zstd 多帧 JSONL），抽出每步的 reasoning。
// 只依赖 Node 内置模块（node:zlib 的 zstd 需要 Node ≥ 22.15 / 24）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

/** 扫描多帧 zstd：返回完整帧区间，以及末尾不完整帧的起点。 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

function decompressAll(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts = [];
  for (const f of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)));
    } catch {
      /* 单帧损坏就跳过，保住其余内容 */
    }
  }
  if (tornStart !== undefined && tornStart < buffer.length) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(tornStart), {
        finishFlush: zlib.constants.ZSTD_e_flush,
      }));
    } catch {
      /* 半截帧解不出来是正常的 */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

export function readSessionEvents(file) {
  const raw = fs.readFileSync(file);
  const text = decompressAll(raw);
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return { events, bytes: raw.length, textLength: text.length };
}

function firstText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === 'text' || c.type === 'input-text'))
    .map((c) => c.text || '')
    .join('\n')
    .trim();
}

function compactArgs(args) {
  if (args == null) return '';
  let v = args;
  if (typeof args === 'string') {
    try {
      v = JSON.parse(args);
    } catch {
      return args.slice(0, 200);
    }
  }
  if (v && typeof v === 'object') {
    const s = Object.keys(v)
      .slice(0, 4)
      .map((k) => `${k}=${typeof v[k] === 'string' ? v[k].slice(0, 60) : '…'}`)
      .join('  ');
    return s;
  }
  return String(v).slice(0, 200);
}

/** 把事件流折叠成「轮 → 步 → reasoning」结构。对 v0..v4 尽量宽容。 */
export function foldSession(events, meta = {}) {
  const info = {
    id: meta.id || '',
    file: meta.file || '',
    cwd: '',
    createdAt: 0,
    updatedAt: 0,
    title: '',
    version: null,
    agentPreset: '',
  };
  const turns = new Map();
  const pendingUser = [];
  let currentTurn = 0;
  let lastTime = 0;
  let toolCalls = 0;

  const ensureTurn = (turn) => {
    if (!turns.has(turn)) {
      turns.set(turn, {
        turn,
        startedAt: 0,
        endedAt: 0,
        userText: '',
        steps: new Map(),
      });
    }
    return turns.get(turn);
  };
  const ensureStep = (turn, step) => {
    const t = ensureTurn(turn);
    if (!t.steps.has(step)) {
      t.steps.set(step, {
        step,
        time: 0,
        reasoning: [],
        // v0/v1 归档把思考写成流式增量（reasoning-chunks），assistant/message 里可能没有；
        // 先收在这里，最后哪一步没有 reasoning 就用它补上。
        chunks: [],
        tools: [],
        text: '',
        model: '',
      });
    }
    return t.steps.get(step);
  };

  for (const e of events || []) {
    if (!e || typeof e !== 'object') continue;
    const d = e.data || {};
    const time = Number(e.time) || 0;
    if (time > lastTime) lastTime = time;

    switch (e.type) {
      case 'session': {
        info.id = e.id || info.id;
        info.cwd = e.cwd || info.cwd;
        info.createdAt = Number(e.createdAt) || info.createdAt;
        info.version = e.version ?? info.version;
        info.agentPreset = e.agentPreset || info.agentPreset;
        break;
      }
      case 'session/title': {
        if (d.title) info.title = String(d.title);
        break;
      }
      case 'turn/start': {
        currentTurn = Number(d.turn) || currentTurn + 1;
        const t = ensureTurn(currentTurn);
        t.startedAt = t.startedAt || time;
        break;
      }
      case 'turn/end': {
        const t = ensureTurn(Number(d.turn) || currentTurn);
        t.endedAt = time;
        break;
      }
      case 'user/message': {
        const text = firstText(d.content);
        if (text) {
          pendingUser.push(text);
          const n = Number(d.turn) || currentTurn + (turns.size === 0 ? 1 : 0) || currentTurn;
          const t = ensureTurn(n || currentTurn);
          if (!t.userText) t.userText = text;
        }
        break;
      }
      case 'agent/inbox/spliced': {
        const inserted = Array.isArray(d.inserted) ? d.inserted : [];
        for (const m of inserted) {
          if (m && m.role === 'user') {
            const text = firstText(m.content);
            if (text) pendingUser.push(text);
          }
        }
        break;
      }
      case 'assistant/message': {
        const turn = Number(d.turn) || currentTurn || 1;
        const step = Number(d.step) || (ensureTurn(turn).steps.size + 1);
        const s = ensureStep(turn, step);
        s.time = s.time || time;
        const content = (d.message && d.message.content) || [];
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'reasoning' && c.text) {
            s.reasoning.push(String(c.text));
          } else if (c.type === 'tool-call') {
            s.tools.push({ id: c.id || '', name: c.name || '?', args: compactArgs(c.arguments) });
            toolCalls++;
          } else if (c.type === 'text' && c.text) {
            s.text += (s.text ? '\n' : '') + String(c.text);
          }
        }
        break;
      }
      case 'reasoning-chunks': {
        const turn = Number(d.turn) || currentTurn || 1;
        const step = Number(d.step) || 1;
        const s = ensureStep(turn, step);
        if (!s.time) s.time = Number(e.time0) || time || 0;
        if (Number(e.time0) > lastTime) lastTime = Number(e.time0);
        if (Array.isArray(d.texts)) {
          for (const t of d.texts) if (t != null) s.chunks.push(String(t));
        }
        break;
      }
      case 'tool/call': {
        const turn = Number(d.turn) || currentTurn || 1;
        const step = Number(d.step) || 1;
        const s = ensureStep(turn, step);
        if (!s.tools.some((t) => t.id && t.id === d.callId)) {
          s.tools.push({ id: d.callId || '', name: d.name || '?', args: compactArgs(d.arguments) });
          toolCalls++;
        }
        break;
      }
      case 'model/selection': {
        info.model = d.model || d.name || info.model;
        break;
      }
      case 'request/header': {
        const cfg = (d.header && d.header.config) || d.config;
        if (cfg && cfg.model && !info.model) info.model = cfg.model;
        break;
      }
      default:
        break;
    }
  }

  // 没有 turn/start 的旧格式：用 pendingUser 的顺序兜底
  const list = [...turns.values()]
    .filter((t) => t.steps.size || t.userText)
    .sort((a, b) => a.turn - b.turn);

  let userCursor = 0;
  for (const t of list) {
    if (!t.userText) {
      const next = pendingUser[userCursor];
      if (next) t.userText = next;
      userCursor++;
    }
    t.steps = [...t.steps.values()].sort((a, b) => a.step - b.step);
  }

  const reasoning = [];
  let reasoningCount = 0;
  let reasoningChars = 0;
  for (const t of list) {
    for (const s of t.steps) {
      // 旧归档：整步的思考只存在 reasoning-chunks 里，assistant/message 没带 reasoning。
      if (!s.reasoning.length && s.chunks.length) {
        const joined = s.chunks.join('').trim();
        if (joined) s.reasoning.push(joined);
      }
      delete s.chunks;
      for (const text of s.reasoning) {
        reasoningCount++;
        reasoningChars += text.length;
        reasoning.push({ turn: t.turn, step: s.step, time: s.time, text });
      }
    }
  }

  info.updatedAt = lastTime;
  if (!info.createdAt) info.createdAt = lastTime;
  if (!info.title) {
    const firstUser = list.find((t) => t.userText);
    info.title = firstUser ? firstUser.userText.replace(/\s+/g, ' ').slice(0, 48) : (info.id || '未命名会话');
  }
  // 会话内用户输入顺序（供旧格式回填用）
  info.userCount = list.filter((t) => t.userText).length;

  return {
    ...info,
    turns: list,
    reasoning,
    stats: {
      turns: list.length,
      steps: list.reduce((n, t) => n + t.steps.length, 0),
      reasoningCount,
      reasoningChars,
      toolCalls,
    },
  };
}

export function workspaceLabel(cwd) {
  if (!cwd) return '未知工作区';
  return cwd;
}
