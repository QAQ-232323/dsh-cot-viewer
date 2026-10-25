# @cetacea/dsh-cot-viewer

在 DSH 里直接翻看、检索、翻译思维链。

## 装了什么

- **侧边栏**多一个「思维链」图标；点开，主区就是完整的思维链浏览器。
- 主面板是一个 iframe，指向宿主提供的 `/dsh-cot/ui/`；数据走 `/dsh-cot/api/*`。
- 数据源：`~/.dsh/sessions` 下的会话归档（只读，不改原始文件）。
- 缓存与设置：`~/.dsh/cot-viewer/`（`translations.jsonl`、`settings.json`）。

## 功能

- 会话列表（按最后活动排序，可按工作区筛选）
- 按「轮 → 步」展开每一步的思考、工具调用、当步回复
- 译文自动出现（只翻视口附近的条目），原文随时可看
- 全库搜索（支持正则），命中点一下跳到那一步并高亮
- 翻译模型可切：DeepSeek 官方 / 本地 Ollama
- 导出当前会话为 Markdown

## 访问控制

- 只接受本机回环 Host。
- API 要求 `X-Cot-Client: 1` 头：同源页面能带；跨域网页要带必须先过 CORS 预检，本服务不发 CORS 头，所以挡得住。
- 没有使用 `connection.requestRejection`：它按 DSH 自己的客户端凭据判定，面板页面的同源 fetch 没有那份凭据（实测 401），会把自己人也拦在外面。

## 卸载

1. 从 `~/.dsh/profiles/desktop/cordis.patch.yml` 删掉 `dsh-cot-viewer` 的 insert 块。
2. 从 `package.json` 的 dependencies 删掉 `@cetacea/dsh-cot-viewer`，并删除 `node_modules/@cetacea/dsh-cot-viewer` 的 junction。
3. 重启 DSH。

## 注意

改宿主代码（`lib/index.js`、`lib/core.mjs`）后需要重启 DSH 才会生效；改 UI（`ui/`）刷新面板即可。

## 2026-10-25 自检修复

- 长文本（>4000 字）分块翻译时，块间补空行，不再粘段。
- 旧格式里只在 `reasoning-chunks` 的思考会补回（约 3.4 万字）。
- 前端出错时关流、不再白花上游额度；流截断不会卡在「翻译中」。
- 导出 Markdown 带上新译文；切回译文视图会补翻视口附近的块；连点会话不再串台。
- 宿主侧 SSE 写失败不再带崩 DSH；坏 JSON 返回 400；翻译缓存改为原子写。
- 已翻过的长文本缓存（34 条）仍是旧版（内容完整、少空行），需要时点单条「重译」。
