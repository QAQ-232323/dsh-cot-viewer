/**
 * @cetacea/dsh-cot-viewer —— 客户端半边：侧边栏加一个「思维链」入口，主区放浏览器面板。
 *
 * 面板本体是 /dsh-cot/ui/（宿主半边提供的页面），用 iframe 装进来：
 * 样式完全隔离，也不会和 DSH 自己的布局打架。
 *
 * 2026-10-22 23:45 拾雨：加幂等守卫。DSH 的 client-modules 在同一个页面里第二次执行
 * 同一个 bundle 会抛 duplicate factory registration，整条 entry 就起不来 —— 2026-10-22
 * 23:31 与 23:33 两次启动失败都是这个。改成「注册只做一次、重复执行只留一条警告」，
 * 这样即使被装两遍也不会再炸掉 web boot。
 *
 * 2026-10-23 17:55 拾雨：真正的病根是注册 id 写成了 'dsh-cot-viewer'（profile 里的 entry id），
 * 而 client-modules 用**包名** '@cetacea/dsh-cot-viewer' 建行、导 bundle —— 注册对不上行，
 * 前端就报 import failed，web boot 直接判死。已在下面的 load() 里改成包名。
 */
(() => {
  // 注意：这里必须包在 IIFE 里 —— 顶层的 const 在同一个页面重复执行会报
  // "Identifier has already been declared"，守卫自己就成了新的崩溃点。
  const COT_CLIENT_LOADED = Symbol.for('@cetacea/dsh-cot-viewer/client-loaded');

  if (window[COT_CLIENT_LOADED]) {
    console.warn('[dsh-cot-viewer] client bundle executed twice, skip duplicate registration');
    return;
  }
  window[COT_CLIENT_LOADED] = true;

  try {
    console.info('[dsh-cot-viewer] client bundle registered as @cetacea/dsh-cot-viewer');
  } catch {
    /* 控制台不可用也不影响注册 */
  }

  window.__ModuleLoader__.load({
    // 2026-10-23 17:5x 拾雨：这里必须写**包名**，不是 profile 里的 entry id。
    // client-modules 按包名建 manifest 行、也按包名 import bundle；写成 'dsh-cot-viewer'
    // 时 bundle 注册了却对不上行，前端就报 "import failed (see console)"，
    // 于是 web boot 判「1 entry did not activate」把整次启动拖死（02:17 与 17:34 两次都是它）。
    // 对照：@dickpy/dsh-imagegen 注册 '@dickpy/dsh-imagegen'、dsh-pet 注册 'dsh-pet'。
    id: '@cetacea/dsh-cot-viewer',
    factory: (require) => {
      const module = { exports: {} };
      const exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      const React = require('react');
      const h = React.createElement;

      const PANEL_ID = 'cot-viewer';

      /** 侧边栏图标：一个脑子。 */
      function CotIcon({ size = 16, active = false }) {
        return h(
          'span',
          {
            style: {
              fontSize: Math.max(12, Math.round(size - 2)),
              lineHeight: 1,
              opacity: active ? 1 : 0.82,
              filter: active ? 'none' : 'grayscale(.25)',
            },
            'aria-hidden': 'true',
          },
          '🧠',
        );
      }

      /** 面板加载失败时不要拖垮整个界面。 */
      class CotBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error };
        }

        componentDidCatch(error) {
          try {
            console.warn('[dsh-cot-viewer] panel crashed:', error);
          } catch {
            /* ignore */
          }
        }

        render() {
          if (this.state.error) {
            return h(
              'div',
              { style: { padding: 24, fontSize: 13, lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary, #98a2b6)' } },
              h('div', { style: { fontSize: 15, marginBottom: 8 } }, '思维链面板没能打开'),
              h('div', null, String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)),
              h(
                'div',
                { style: { marginTop: 12 } },
                '也可以直接打开 ',
                h('a', { href: '/dsh-cot/ui/', target: '_blank', rel: 'noreferrer' }, '/dsh-cot/ui/'),
                ' 看同一份内容。',
              ),
            );
          }
          return this.props.children;
        }
      }

      /** 主面板：iframe 装下整个思维链浏览器。 */
      function CotPanel() {
        return h(
          CotBoundary,
          null,
          h(
            'div',
            {
              style: {
                width: '100%',
                height: '100%',
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                background: 'var(--dsw-alias-bg-base, #0e1116)',
              },
            },
            h('iframe', {
              src: '/dsh-cot/ui/',
              title: '思维链浏览器',
              style: { flex: 1, width: '100%', height: '100%', border: 0, display: 'block' },
            }),
          ),
        );
      }

      function apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, CotPanel),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => '思维链' },
            CotIcon,
          ),
        );
      }

      exports.apply = apply;
      exports.inject = ['slots'];
      exports.CotIcon = CotIcon;
      exports.CotPanel = CotPanel;
      return module.exports;
    },
  });
})();
