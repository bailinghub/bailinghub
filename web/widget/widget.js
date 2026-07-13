/* 百灵中枢 · 网页聊天组件（零依赖单文件，Shadow DOM 隔离样式）
 * 用法：<script src="https://你的中枢/widget.js" data-entry="pub_xxx" async></script>
 * 可选：data-open="1" 加载即展开（演示页用）；
 *       data-ticket="v1.xxx.yyy" 签名访客票据（业务后端在登录态里签发后输出到页面，让登录用户带可信身份；游客不带照常匿名聊）。
 * 标题/开场白/主色在控制台「聊天入口」配置，改完即生效（组件每次加载拉取 /chat/:entry/config）。
 * 安全边界：entry_key 可公开；消息走 POST /chat/:entry（Origin 白名单+IP 限速在中枢侧）；
 * 组件只持有 visitor_id（会话连续性用的随机串）与服务端签好的票据，自己造不出任何业务身份。
 *
 * ── 嵌入契约（WIDGET_API，受 SemVer 约束的 wire 面；详见 docs/兼容性与升级.md「嵌入组件契约」）──
 * 这是业务系统嵌入聊天入口时依赖的稳定面：
 *   · 脚本属性：data-entry（必填，^[a-z0-9_-]{4,32}$）、data-open、data-ticket
 *   · 全局对象：window.BailingChat.setContext({page_key,page_name})、window.BailingChat.apiVersion
 *   · 端点族：  /chat/:entry、/chat/:entry/config、/chat/:entry/events/:jobId、
 *              /chat/:entry/thread、/chat/:entry/rate/:jobId、/chat/:entry/upload
 * 对话主链路：POST 创建任务 → SSE events 接收状态和最终回答；thread 用于断线恢复和会话回灌。
 */
(() => {
  const WIDGET_API = '1'; // 嵌入契约主版本；仅破坏性变更才 +1（见上方契约说明）
  const script = document.currentScript;
  if (!script) return;
  const ENTRY = script.dataset.entry;
  if (!ENTRY || !/^[a-z0-9_-]{4,32}$/.test(ENTRY)) { console.warn('[百灵聊天组件] data-entry 缺失或不合法'); return; }
  const HUB = new URL(script.src).origin;
  const AUTO_OPEN = script.dataset.open === '1';
  const TICKET = script.dataset.ticket || '';
  const LS_VISITOR = `bailing_visitor_${ENTRY}`;
  const LS_HISTORY = `bailing_chat_${ENTRY}`;
  const LS_THREAD = `bailing_thread_${ENTRY}`; // 当前会话线程 id（开新对话=换一个）；空=默认线程
  const LS_POS = `bailing_pos_${ENTRY}`;   // 访客拖动后的位置（距锚定侧/底的 px），记住下次还在那
  const LS_SIZE = `bailing_size_${ENTRY}`; // 访客拖边框改的尺寸 {w,h}（仅 cfg.resizable 开时），记住下次还这么大
  const RECOVER_DELAYS = [600, 1200, 2400]; // 公开面弱网恢复：短退避，不让一次 fetch 抖动变成错误气泡

  // 页面上下文（理解层）：自动抓 path+hash（去 query 防泄露）+ 标题随每条消息上报；
  // 中枢按「页面登记表」模式匹配出"这是哪个页面、干嘛的"，注入给 AI + 落任务详情，便于精准定位用户问题。
  // 接入方可选 window.BailingChat.setContext({page_key,page_name}) 显式声明语义页面（SPA 无 URL 语义时的逃生口，非必需）。
  window.BailingChat = window.BailingChat || {};
  window.BailingChat.apiVersion = WIDGET_API; // 嵌入方/排查可读：当前组件的嵌入契约主版本
  window.BailingChat.setContext = (o) => { try { window.BailingChat._ctx = (o && typeof o === 'object') ? o : null; } catch { /* 忽略 */ } };
  // 保留 path+query+hash（很多传统后台的页面身份就在 query 里），但抹掉敏感参数值与超长值，防 token/PII 泄露
  const SENSITIVE_Q = /(token|sign|secret|password|passwd|pwd|apikey|api_key|accesstoken|access_token|sessionkey|session_?id|session|auth|ticket|openid|unionid|mobile|phone|idcard|email|code|skey)/i;
  function redactSearch(search) {
    const q = String(search || '').replace(/^\?/, '');
    if (!q) return '';
    const out = [];
    for (const kv of q.split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      const k = eq >= 0 ? kv.slice(0, eq) : kv;
      const v = eq >= 0 ? kv.slice(eq + 1) : '';
      out.push((SENSITIVE_Q.test(k) || v.length > 48) ? k + '=' : kv);
    }
    return out.length ? '?' + out.join('&') : '';
  }
  function collectPageContext() {
    const c = {};
    try { c.url = (location.pathname + redactSearch(location.search) + (location.hash || '')).slice(0, 400); } catch { /* 沙箱/隐私模式 */ }
    try { if (document.title) c.title = document.title.slice(0, 200); } catch { /* 忽略 */ }
    const ext = window.BailingChat && window.BailingChat._ctx;
    if (ext && typeof ext === 'object') {
      if (ext.page_key) c.page_key = String(ext.page_key).slice(0, 64);
      if (ext.page_name) c.page_name = String(ext.page_name).slice(0, 128);
    }
    return c;
  }

  // ---- 状态 ----
  let visitorId = '';
  try { visitorId = localStorage.getItem(LS_VISITOR) || ''; } catch { /* 隐私模式等 */ }
  // 当前会话线程：已验身份（visitor_id / 票据 uid）下的平行会话分区键。空=默认线程；
  // 点「开启新对话」时换一个新 id，后端按 thread 切 scope → 全新 session+总账，前一段上下文不再参与新会话（登录用户也生效）。
  let threadId = '';
  try { threadId = (localStorage.getItem(LS_THREAD) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32); } catch { /* 隐私模式 */ }
  let history = [];
  try { history = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch { history = []; }
  if (!Array.isArray(history)) history = [];
  let pending = false;
  let pendingAtt = null; // 待发送的媒体附件 {type,url,name,uploading?,error?}（单个，再选/录会替换）
  let cfg = { enabled: true, title: '在线咨询', greeting: '', color: '#7a5b3a', brand: '',
    width: 400, height: 600, title_align: 'center', position: 'right', offset_x: 24, offset_y: 24, avatar: '', launcher_icon: '', resizable: false, ai_notice: true,
    powered_by_visible: true, powered_by_text: '' };

  function saveHistory() {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(history.slice(-50))); } catch { /* 容量/隐私模式 */ }
  }
  // 生成新会话线程 id（[a-z0-9]，≤32，与后端清洗规则一致）；crypto 不可用时退回时间戳+随机
  function newThreadId() {
    let r = '';
    try { r = (crypto.randomUUID && crypto.randomUUID().replace(/-/g, '')) || ''; } catch { /* 非安全上下文等 */ }
    if (!r) r = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return ('t' + r).slice(0, 32);
  }

  // ---- DOM（Shadow DOM 隔离，不污染宿主页面）----
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;width:0;height:0;visibility:hidden;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .bubble { position: fixed; bottom: var(--off-y, 24px); right: var(--off-x, 24px); width: 56px; height: 56px; border-radius: 50%;
      background: var(--accent); color: #fff; border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.18);
      display: flex; align-items: center; justify-content: center; transition: transform .15s; overflow: hidden; }
    .bubble:hover { transform: scale(1.06); }
    .bubble svg { width: 26px; height: 26px; }
    .bubble img.licon { width: 30px; height: 30px; object-fit: contain; }
    .pos-left .bubble { left: var(--off-x, 24px); right: auto; }
    .panel { position: fixed; bottom: calc(var(--off-y, 24px) + 68px); right: var(--off-x, 24px);
      width: var(--panel-w, 400px); max-width: calc(100vw - 32px);
      height: var(--panel-h, 600px); max-height: calc(100vh - 120px); background: #faf9f7; border-radius: 14px;
      box-shadow: 0 8px 40px rgba(0,0,0,.22); display: none; flex-direction: column; overflow: hidden; }
    .pos-left .panel { left: var(--off-x, 24px); right: auto; }
    .panel.open { display: flex; }
    /* 访客拖边框改尺寸（cfg.resizable 开才显示）：上边改高、侧边改宽；面板锚右下角故向上/向左长，侧边贴左缘，左下锚时翻到右缘 */
    .panel .rz { position: absolute; z-index: 6; display: none; }
    .panel.rzable .rz { display: block; }
    .panel.rzable .rz:hover { background: rgba(0,0,0,.06); }
    .rz-t { top: 0; left: 0; right: 0; height: 7px; cursor: ns-resize; }
    .rz-s { top: 0; bottom: 0; left: 0; width: 7px; cursor: ew-resize; }
    .pos-left .rz-s { left: auto; right: 0; }
    .head { position: relative; background: var(--accent); color: #fff; padding: 12px 14px; min-height: 50px;
      display: flex; align-items: center; gap: 8px; user-select: none; }
    .panel.open .head { cursor: grab; }
    .panel.open .head.dragging { cursor: grabbing; }
    .panel.open .head .ctrls, .panel.open .head .ctrls button { cursor: pointer; }
    .head .avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover;
      background: rgba(255,255,255,.18); flex-shrink: 0; display: none; }
    .head .avatar.on { display: block; }
    .head .t { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      max-width: 60%; text-align: center; font-size: 15px; font-weight: 600;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head.tl .t { position: static; transform: none; left: auto; top: auto; max-width: none; flex: 1; text-align: left; }
    .head .ctrls { margin-left: auto; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .head button { background: none; border: none; color: #fff; cursor: pointer; line-height: 1; opacity: .85; padding: 2px 3px; }
    .head button:hover { opacity: 1; }
    .head .close { font-size: 18px; }
    .head .restart svg { width: 19px; height: 19px; display: block; }
    .msgs { flex: 1; overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 10px; }
    .m { max-width: 82%; padding: 9px 12px; border-radius: 12px; font-size: 14px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-word; }
    .m.u { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
    .m.a { align-self: flex-start; background: #fff; color: #3d372f; border: 1px solid #ece8e1; border-bottom-left-radius: 4px; }
    .m.err { background: #fdf2f0; color: #b3554a; border: 1px solid #f3ded9; }
    .m img { display: block; max-width: 100%; border-radius: 8px; margin: 6px 0; }
    .m a { color: inherit; }
    /* markdown 渲染（仅 AI 回复气泡 .md）：块级布局自理间距，故关掉 pre-wrap */
    .m.md { white-space: normal; }
    .m.md > *:first-child { margin-top: 0; }
    .m.md > *:last-child { margin-bottom: 0; }
    .m.md p { margin: 6px 0; white-space: pre-wrap; }
    .m.md h3 { font-size: 15px; font-weight: 700; margin: 10px 0 4px; }
    .m.md h4 { font-size: 14px; font-weight: 700; margin: 8px 0 3px; }
    .m.md ul, .m.md ol { margin: 6px 0; padding-left: 20px; }
    .m.md li { margin: 2px 0; }
    .m.md blockquote { margin: 6px 0; padding: 4px 10px; border-left: 3px solid #e3ded5;
      color: #6f685c; background: #faf9f7; border-radius: 0 6px 6px 0; }
    .m.md code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px;
      background: #f3f0ea; padding: 1px 5px; border-radius: 4px; word-break: break-all; }
    .m.md pre { background: #f6f4ef; border: 1px solid #ece8e1; border-radius: 8px;
      padding: 8px 10px; overflow-x: auto; margin: 8px 0; }
    .m.md pre code { background: none; padding: 0; white-space: pre; word-break: normal; line-height: 1.5; }
    .m.md hr { border: none; border-top: 1px solid #ece8e1; margin: 10px 0; }
    .m.md strong { font-weight: 700; }
    .m.md em { font-style: italic; }
    .m.md a { color: var(--accent); text-decoration: underline; word-break: break-all; }
    .m.md table { border-collapse: collapse; margin: 8px 0; font-size: 13px; display: block; overflow-x: auto; }
    .m.md th, .m.md td { border: 1px solid #e3ded5; padding: 4px 8px; text-align: left; white-space: nowrap; }
    .m.md th { background: #f6f4ef; font-weight: 600; }
    .typing { align-self: flex-start; padding: 12px 14px; }
    .typing i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #b8b0a4; margin: 0 2px;
      animation: blink 1.2s infinite; font-style: normal; }
    .typing i:nth-child(2) { animation-delay: .2s; } .typing i:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%,80%,100% { opacity: .25; } 40% { opacity: 1; } }
    .foot { border-top: 1px solid #ece8e1; background: #fff; padding: 10px; display: flex; gap: 8px; align-items: flex-end; }
    .foot textarea { flex: 1; resize: none; border: none; outline: none; font-size: 14px; line-height: 1.5;
      max-height: 90px; min-height: 22px; background: transparent; color: #3d372f; }
    .foot button { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 7px 14px;
      font-size: 13px; cursor: pointer; flex-shrink: 0; }
    .foot button:disabled { opacity: .45; cursor: default; }
    .brand { text-align: center; font-size: 11px; color: #b8b0a4; padding: 4px 0 6px; background: #fff; }
    .brand:empty { display: none; }
    .refs { align-self: flex-start; max-width: 82%; font-size: 11px; color: #8a8378; line-height: 1.6;
      margin-top: -4px; padding: 0 4px; }
    .refs b { color: #6f685c; font-weight: 600; }
    .ai-notice { align-self: flex-start; max-width: 82%; margin-top: -6px; padding-left: 6px;
      font-size: 11px; line-height: 1.5; color: #aaa397; }
    .ai-notice b { color: #8c8478; font-weight: 600; }
    .reply-actions { align-self: flex-start; max-width: 82%; display: flex; justify-content: flex-start; align-items: center;
      gap: 6px; margin-top: -6px; padding-left: 6px; }
    .rate { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-start; }
    .rate button { position: relative; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 999px; color: #a59d91; padding: 0; cursor: pointer; }
    .rate button:hover { color: var(--accent); background: rgba(0,0,0,.035); }
    .rate button.sel { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .rate button.busy { opacity: .55; pointer-events: none; }
    .rate button.copied { color: var(--accent); }
    .rate button.has-refs { color: #8f877b; }
    .rate button::after { content: attr(data-tip); position: absolute; left: 50%; bottom: calc(100% + 7px);
      transform: translateX(-50%) translateY(2px); opacity: 0; pointer-events: none; z-index: 20;
      background: #3f3b35; color: #fff; border: 1px solid rgba(255,255,255,.08); border-radius: 4px;
      box-shadow: 0 4px 14px rgba(0,0,0,.18); padding: 3px 7px; font-size: 11px; line-height: 1.4;
      white-space: nowrap; transition: opacity .12s ease, transform .12s ease; }
    .rate button::before { content: ''; position: absolute; left: 50%; bottom: calc(100% + 2px);
      width: 6px; height: 6px; background: #3f3b35; transform: translateX(-50%) rotate(45deg);
      opacity: 0; pointer-events: none; z-index: 19; transition: opacity .12s ease; }
    .rate button:hover::after, .rate button:focus-visible::after { opacity: 1; transform: translateX(-50%) translateY(0); }
    .rate button:hover::before, .rate button:focus-visible::before { opacity: 1; }
    .rate svg { width: 17px; height: 17px; display: block; fill: currentColor; }
    .rate .done { border: none; color: #b8b0a4; cursor: default; padding: 2px 4px; }
    .refs-panel { align-self: flex-start; width: min(82%, 360px); margin-top: -2px; padding-left: 6px;
      font-size: 11px; color: #8a8378; line-height: 1.7; }
    .refs-panel span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .refs-panel b { color: #6f685c; font-weight: 600; }
    .fbbox { align-self: flex-start; width: min(82%, 360px); display: flex; flex-direction: column; gap: 6px;
      margin-top: -2px; padding-left: 6px; }
    .fbbox textarea { width: 100%; min-height: 58px; resize: vertical; border: 1px solid #e3ded5; border-radius: 8px;
      padding: 8px 10px; outline: none; color: #3d372f; font-size: 12px; line-height: 1.5; background: #fff; }
    .fbbox textarea:focus { border-color: var(--accent); }
    .fbbox .fbops { display: flex; gap: 6px; justify-content: flex-end; }
    .fbbox button { background: none; border: 1px solid #e3ded5; border-radius: 999px; color: #8a8378;
      font-size: 11px; padding: 2px 10px; cursor: pointer; }
    .fbbox button.primary { border-color: var(--accent); color: var(--accent); }
    .att { align-self: flex-start; max-width: 82%; margin-top: -2px; font-size: 13px; color: #6f685c;
      background: #fff; border: 1px solid #ece8e1; border-radius: 10px; padding: 7px 12px; text-decoration: none; }
    .att:hover { border-color: var(--accent); color: var(--accent); }
    .m-img { align-self: flex-end; max-width: 180px; max-height: 180px; border-radius: 10px;
      border: 1px solid #ece8e1; margin: 2px 0; display: block; }
    .foot .send { transform: translateY(2px); }
    .foot .attach, .foot .voice { background: none; border: none; color: #b3ada2; cursor: pointer;
      line-height: 1; padding: 4px 2px; flex-shrink: 0; align-self: flex-end; transform: translateY(2px); }
    .foot .attach svg, .foot .voice svg { width: 22px; height: 22px; display: block; }
    .foot .attach:hover, .foot .voice:hover, .foot .voice.rec { color: var(--accent); }
    .foot .attach:disabled, .foot .voice:disabled { opacity: .45; cursor: default; }
    .attbar { display: none; gap: 8px; flex-wrap: wrap; padding: 8px 10px 0; background: #fff; }
    .attbar.on { display: flex; }
    .attchip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border: 1px solid #ece8e1;
      border-radius: 8px; padding: 4px 6px 4px 4px; background: #faf9f7; font-size: 12px; color: #6f685c; }
    .attchip img { width: 30px; height: 30px; object-fit: cover; border-radius: 5px; flex-shrink: 0; }
    .attchip .audio-ico { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.04); color: var(--accent); flex-shrink: 0; }
    .attchip .nm { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attchip.err { color: #b3554a; border-color: #f3ded9; background: #fdf2f0; }
    .attchip button { background: none; border: none; color: #b8b0a4; cursor: pointer; font-size: 15px;
      line-height: 1; padding: 0 2px; }
    .attchip button:hover { color: #b3554a; }
    /* 移动端自适应：小屏面板接近全屏，沟通不憋屈（!important 压过位置/尺寸变量与 .pos-left 高优先级规则）*/
    @media (max-width: 480px) {
      .panel { width: calc(100vw - 16px) !important; height: calc(100dvh - 92px) !important;
        max-width: calc(100vw - 16px) !important; max-height: calc(100dvh - 92px) !important;
        left: 8px !important; right: 8px !important; bottom: 84px !important; border-radius: 12px; }
      .panel .rz { display: none !important; }  /* 手机端面板已全屏，拖动改尺寸无意义 */
    }
  `;
  root.appendChild(style);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="panel" part="panel">
      <div class="rz rz-t" data-rz="y"></div><div class="rz rz-s" data-rz="x"></div>
      <div class="head"><img class="avatar" alt=""><span class="t"></span><div class="ctrls"><button class="restart" type="button" aria-label="开启新对话" title="开启新对话"><svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M788.266667 625.749333A298.666667 298.666667 0 1 1 721.024 298.666667H640a42.666667 42.666667 0 0 0 0 85.333333h170.666667a42.666667 42.666667 0 0 0 42.666666-42.666667V170.666667a42.666667 42.666667 0 0 0-85.333333 0v55.125333A384 384 0 0 0 128 512a384 384 0 0 0 739.2 146.133333 42.666667 42.666667 0 0 0-78.890667-32.341333l-0.042666-0.042667z"/></svg></button><button class="close" type="button" aria-label="关闭">✕</button></div></div>
      <div class="msgs"></div>
      <div class="attbar"></div>
      <div class="foot"><button class="attach" type="button" aria-label="添加附件" title="添加附件" style="display:none"><svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M85.333333 512C85.333333 276.352 276.352 85.333333 512 85.333333s426.666667 191.018667 426.666667 426.666667-191.018667 426.666667-426.666667 426.666667S85.333333 747.648 85.333333 512z m426.666667-341.333333a341.333333 341.333333 0 1 0 0 682.666666 341.333333 341.333333 0 0 0 0-682.666666z m0 128a42.666667 42.666667 0 0 1 42.666667 42.666666v128h128a42.666667 42.666667 0 1 1 0 85.333334h-128v128a42.666667 42.666667 0 1 1-85.333334 0v-128H341.333333a42.666667 42.666667 0 1 1 0-85.333334h128V341.333333a42.666667 42.666667 0 0 1 42.666667-42.666666z"/></svg></button><input class="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,text/csv,text/tab-separated-values,text/html,text/xml,text/yaml,text/x-log,text/x-ini,text/x-conf,application/json,application/x-ndjson,application/xml,application/yaml,application/x-yaml,application/sql,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/zip,application/x-rar-compressed,application/x-7z-compressed,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.html,.htm,.log,.ini,.conf,.sql,.yaml,.yml,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar,.7z" hidden><button class="voice" type="button" aria-label="按住录音" title="点击开始/停止录音" style="display:none"><svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M512 640a128 128 0 0 0 128-128V224a128 128 0 0 0-256 0v288a128 128 0 0 0 128 128z"/><path d="M768 448a42.667 42.667 0 0 0-85.333 0v64a170.667 170.667 0 0 1-341.334 0v-64a42.667 42.667 0 0 0-85.333 0v64a256.171 256.171 0 0 0 213.333 252.373V832H384a42.667 42.667 0 0 0 0 85.333h256A42.667 42.667 0 0 0 640 832h-85.333v-67.627A256.171 256.171 0 0 0 768 512v-64z"/></svg></button><textarea rows="1" placeholder="输入你的问题…"></textarea><button class="send">发送</button></div>
      <div class="brand"></div>
    </div>
    <button class="bubble" aria-label="打开聊天">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-9 8.36 8.5 8.5 0 0 1-3.4-.7L3 21l1.84-4.6A8.38 8.38 0 0 1 3.5 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/>
      </svg>
    </button>`;
  root.appendChild(wrap);

  const panel = wrap.querySelector('.panel');
  const msgsEl = wrap.querySelector('.msgs');
  const inputEl = wrap.querySelector('textarea');
  const sendBtn = wrap.querySelector('.send');
  const titleEl = wrap.querySelector('.t');
  const brandEl = wrap.querySelector('.brand');
  const attbarEl = wrap.querySelector('.attbar');
  const attachBtn = wrap.querySelector('.attach');
  const fileEl = wrap.querySelector('.file');
  const voiceBtn = wrap.querySelector('.voice');
  const headEl = wrap.querySelector('.head');
  const avatarEl = wrap.querySelector('.avatar');
  const bubbleEl = wrap.querySelector('.bubble');
  const restartBtn = wrap.querySelector('.restart');

  function setAccent(c) { host.style.setProperty('--accent', c); wrap.style.setProperty('--accent', c); }
  setAccent(cfg.color);

  // 外观套用（尺寸/位置偏移/标题对齐/头像/自定义气泡图标）——配置拉到后调用一次；缺省走 CSS 内置 fallback
  function clampN(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt; }
  // 当前位置/尺寸状态（供拖动与 resize 重夹用）：curX/curY = 气泡距锚定侧/底的 px；curW/curH = 配置面板尺寸
  let curX = 24, curY = 24, curW = 400, curH = 600;
  function setOff(x, y) {
    curX = x; curY = y;
    for (const node of [host, wrap]) { node.style.setProperty('--off-x', x + 'px'); node.style.setProperty('--off-y', y + 'px'); }
  }
  function applyPanelSize() {
    for (const node of [host, wrap]) { node.style.setProperty('--panel-w', curW + 'px'); node.style.setProperty('--panel-h', curH + 'px'); }
  }
  // 把位置夹回视口内（用配置尺寸套 CSS 视口封顶值，故面板未展开也能算）；8px 安全边
  function clampOff(ox, oy) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const W = Math.min(curW, vw - 32), H = Math.min(curH, vh - 120);
    const maxX = Math.max(8, vw - W - 8), maxY = Math.max(8, vh - H - 76);  // 76 ≈ 气泡高距 68 + 边距 8
    return { x: Math.min(Math.max(ox, 8), maxX), y: Math.min(Math.max(oy, 8), maxY) };
  }
  function applyAppearance() {
    curW = clampN(cfg.width, 280, 720, 400);
    curH = clampN(cfg.height, 360, 900, 600);
    applyPanelSize();
    setOff(clampN(cfg.offset_x, 0, 400, 24), clampN(cfg.offset_y, 0, 400, 24));
    wrap.classList.toggle('pos-left', cfg.position === 'left');
    if (panel) panel.classList.toggle('rzable', !!cfg.resizable);
    if (headEl) headEl.classList.toggle('tl', cfg.title_align === 'left');
    if (avatarEl) {
      if (cfg.avatar) { avatarEl.src = cfg.avatar; avatarEl.classList.add('on'); }
      else { avatarEl.classList.remove('on'); avatarEl.removeAttribute('src'); }
    }
    if (bubbleEl && cfg.launcher_icon) {
      bubbleEl.replaceChildren();
      const im = document.createElement('img'); im.className = 'licon'; im.src = cfg.launcher_icon; im.alt = '';
      bubbleEl.appendChild(im);
    }
  }

  // AI 回复的轻量 markdown 渲染：标题/加粗/斜体/行内·块代码/链接/图片/有序无序列表/引用/表格/分隔线/软换行。
  // 安全铁律：全程 createElement + textContent/append（文本节点），绝不 innerHTML——杜绝注入；图挂了退化为可点链接。
  // 商城等接入方 100% 复用本组件渲染，markdown 与 attachments 的呈现都由这里负责。
  function makeImg(src, alt) {
    const img = document.createElement('img');
    img.src = src; img.alt = alt || '图片'; img.loading = 'lazy';
    img.addEventListener('error', () => {
      const a = document.createElement('a');
      a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '[图片] ' + img.alt;
      img.replaceWith(a);
    }, { once: true });
    return img;
  }
  // 行内：按"最早命中"在 代码/图片/链接/加粗/斜体 间择一，前缀文本入文本节点，递归处理剩余
  function inlineParse(text, container) {
    const patterns = [
      { re: /`([^`]+)`/, make: (m) => { const c = document.createElement('code'); c.textContent = m[1]; return c; } },
      { re: /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/, make: (m) => makeImg(m[2], m[1]) },
      { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, make: (m) => { const a = document.createElement('a'); a.href = m[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; inlineParse(m[1], a); return a; } },
      { re: /\*\*([\s\S]+?)\*\*/, make: (m) => { const s = document.createElement('strong'); inlineParse(m[1], s); return s; } },
      { re: /\*([^*\n]+?)\*/, make: (m) => { const e = document.createElement('em'); inlineParse(m[1], e); return e; } },
    ];
    let rest = text;
    while (rest) {
      let best = null;
      for (const p of patterns) {
        const m = p.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { p, m };
      }
      if (!best) { container.append(rest); break; }
      if (best.m.index > 0) container.append(rest.slice(0, best.m.index));
      container.appendChild(best.p.make(best.m));
      rest = rest.slice(best.m.index + best.m[0].length);
    }
  }
  // 多行内联：段落/引用内的软换行 → <br>
  function inlineMultiline(text, container) {
    text.split('\n').forEach((part, idx) => {
      if (idx > 0) container.appendChild(document.createElement('br'));
      inlineParse(part, container);
    });
  }
  function isTableDivider(l) {
    return /-/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(l);
  }
  function isTableStartAt(lines, idx) {
    return !!(lines[idx] && lines[idx].includes('|') && idx + 1 < lines.length && isTableDivider(lines[idx + 1]));
  }
  function isBlockStart(l) {
    return /^\s*```/.test(l) || /^#{1,6}\s+/.test(l) || /^\s*>\s?/.test(l) ||
      /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l);
  }
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }
  function buildTable(header, rows) {
    const tbl = document.createElement('table');
    const thead = document.createElement('thead'), htr = document.createElement('tr');
    for (const c of header) { const th = document.createElement('th'); inlineParse(c, th); htr.appendChild(th); }
    thead.appendChild(htr); tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      for (let k = 0; k < header.length; k++) { const td = document.createElement('td'); inlineParse(r[k] || '', td); tr.appendChild(td); }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody); return tbl;
  }
  function renderReply(el, text) {
    el.classList.add('md');
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {                                   // 代码块
        const buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        const pre = document.createElement('pre'), code = document.createElement('code');
        code.textContent = buf.join('\n'); pre.appendChild(code); el.appendChild(pre); continue;
      }
      if (!line.trim()) { i++; continue; }                          // 空行
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { el.appendChild(document.createElement('hr')); i++; continue; } // 分隔线
      const h = line.match(/^(#{1,6})\s+(.*)$/);                    // 标题（气泡里 # ## → h3，其余 → h4）
      if (h) { const node = document.createElement(h[1].length <= 2 ? 'h3' : 'h4'); inlineParse(h[2], node); el.appendChild(node); i++; continue; }
      if (/^\s*>\s?/.test(line)) {                                  // 引用块
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        const bq = document.createElement('blockquote'); inlineMultiline(buf.join('\n'), bq); el.appendChild(bq); continue;
      }
      if (isTableStartAt(lines, i)) {                            // 表格
        const header = splitRow(line); i += 2; const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
        el.appendChild(buildTable(header, rows)); continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {                    // 列表
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const listEl = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const li = document.createElement('li'); inlineParse(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''), li); listEl.appendChild(li); i++;
        }
        el.appendChild(listEl); continue;
      }
      const buf = [line]; i++;                                      // 段落（聚合连续普通行）
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !isTableStartAt(lines, i)) { buf.push(lines[i]); i++; }
      const p = document.createElement('p'); inlineMultiline(buf.join('\n'), p); el.appendChild(p);
    }
  }

  // 打字机逐字显示（仅新到的 AI 回复）：按当前子串重渲 markdown（短文重渲成本可忽略），完成后回调追加来源/评价。
  // 历史回灌、服务端总账、错误气泡都走即时渲染——只有 send() 里刚到的回复带 typing 标志。
  function typeReply(el, text, onDone) {
    el.classList.add('md');
    const full = String(text || ''), total = full.length;
    if (!total) { if (onDone) onDone(); return; }
    const targetMs = Math.min(total * 14, 2200);             // 短文从容、长文加速，整体 ≤2.2s 铺完
    const ticks = Math.max(1, Math.round(targetMs / 24));
    const step = Math.max(1, Math.ceil(total / ticks));
    let i = 0;
    const timer = setInterval(() => {
      i = Math.min(total, i + step);
      el.replaceChildren();
      renderReply(el, full.slice(0, i));
      msgsEl.scrollTop = msgsEl.scrollHeight;
      if (i >= total) { clearInterval(timer); if (onDone) onDone(); }
    }, 24);
  }

  // 用户气泡只显示文字：媒体/文件以 markdown 进消息（让 AI 拿到 URL），展示时剥掉 markdown，改走缩略图/附件卡片渲染
  function stripImgMd(s) {
    return String(s || '')
      .replace(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g, '')
      .replace(/(?<!\!)\[(语音|音频|录音|audio|voice)[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi, '')
      .replace(/(?<!\!)\[(文件|附件|文档|file|document)[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const AI_NOTICE_TEXT = '由 AI 生成，请结合实际业务结果核验。';

  function appendAiNotice(afterEl) {
    if (!afterEl) return null;
    if (cfg.ai_notice === false) return null;
    if (!String(afterEl.textContent || '').trim() && !afterEl.children.length) return null;
    const notice = document.createElement('div');
    notice.className = 'ai-notice';
    const label = document.createElement('b');
    label.textContent = 'AI 提示';
    notice.append(label, document.createTextNode(' · ' + AI_NOTICE_TEXT));
    afterEl.insertAdjacentElement('afterend', notice);
    return notice;
  }

  // 气泡之后追加的富内容（图/文件卡片、知识来源、评价条）——抽出来，便于打字机"铺完正文后再追加"
  function appendExtras(role, isErr, extra, bubbleEl) {
    const isUser = role === 'u';
    // 富内容附件：用户上传的图渲染成右对齐缩略图；助手回复的图已在正文 markdown 内联，故跳过 image；file/未知 type 降级成卡片/链接
    if (extra && Array.isArray(extra.atts)) {
      for (const a of extra.atts) {
        if (!a || !a.url) continue;
        if (a.type === 'image') {
          if (!isUser) continue;
          const im = document.createElement('img');
          im.className = 'm-img'; im.src = a.url; im.alt = a.name || '图片'; im.loading = 'lazy';
          msgsEl.appendChild(im);
          continue;
        }
        const card = document.createElement('a');
        card.className = 'att';
        card.href = a.url; card.target = '_blank'; card.rel = 'noopener noreferrer';
        card.textContent = (a.type === 'file' ? '📄 ' : a.type === 'audio' ? '♪ ' : '🔗 ') + (a.name || a.url);
        msgsEl.appendChild(card);
      }
    }
    let actionAnchor = bubbleEl;
    if (role === 'a' && !isErr && bubbleEl) actionAnchor = appendAiNotice(bubbleEl) || bubbleEl;
    // 评价/复制/文字反馈：只对有 job_id 的正常回答显示。评价状态留在按钮自身，不再额外占一行。
    if (extra && extra.jobId && role === 'a' && !isErr) {
      attachReplyActions(actionAnchor, extra.jobId, extra.voted || '', extra.comment || '', extra.copyText || '', extra.refs || []);
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function addMsg(role, text, isErr, extra) {
    const isUser = role === 'u';
    const disp = isUser ? stripImgMd(text) : String(text || '');
    let el = null;
    if (disp || role === 'a') {                       // 纯图片（无文字）的用户消息不画空气泡，只留缩略图
      el = document.createElement('div');
      el.className = 'm ' + (isUser ? 'u' : 'a') + (isErr ? ' err' : '');
      msgsEl.appendChild(el);
      if (role === 'a' && !isErr) {
        // 新到的回复打字机逐字铺开，铺完再追加来源/评价；其余（历史/错误）即时渲染
        if (extra && extra.typing) { typeReply(el, disp, () => appendExtras(role, isErr, { ...extra, copyText: disp }, el)); return el; }
        renderReply(el, disp);
      } else { el.textContent = disp; }
    }
    appendExtras(role, isErr, extra ? { ...extra, copyText: disp } : extra, el);
    return el;
  }

  function attachReplyActions(bubbleEl, jobId, voted, comment, copyText, refs) {
    if (!bubbleEl) return;
    const actions = document.createElement('div');
    actions.className = 'reply-actions';
    const bar = document.createElement('div');
    bar.className = 'rate';
    renderRateBar(bar, jobId, voted, comment, copyText, refs);
    actions.appendChild(bar);
    bubbleEl.insertAdjacentElement('afterend', actions);
  }

  const ACTION_ICONS = {
    refs: '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M256 341.333333a170.666667 170.666667 0 0 0 0 341.333334h128a42.666667 42.666667 0 1 1 0 85.333333H256A256 256 0 0 1 256 256h128a42.666667 42.666667 0 1 1 0 85.333333H256z m341.333333-42.666666a42.666667 42.666667 0 0 1 42.666667-42.666667h128a256 256 0 0 1 0 512h-128a42.666667 42.666667 0 1 1 0-85.333333h128a170.666667 170.666667 0 0 0 0-341.333334h-128a42.666667 42.666667 0 0 1-42.666667-42.666666z"></path><path d="M298.666667 512a42.666667 42.666667 0 0 1 42.666666-42.666667h341.333334a42.666667 42.666667 0 1 1 0 85.333334H341.333333a42.666667 42.666667 0 0 1-42.666666-42.666667z"></path></svg>',
    copy: '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M768 128h-341.333333C354.133333 128 298.666667 183.466667 298.666667 256v42.666667H256c-72.533333 0-128 55.466667-128 128v341.333333c0 72.533333 55.466667 128 128 128h341.333333c72.533333 0 128-55.466667 128-128v-42.666667h42.666667c72.533333 0 128-55.466667 128-128V256c0-72.533333-55.466667-128-128-128z m-128 640c0 25.6-17.066667 42.666667-42.666667 42.666667H256c-25.6 0-42.666667-17.066667-42.666667-42.666667v-341.333333c0-25.6 17.066667-42.666667 42.666667-42.666667h341.333333c25.6 0 42.666667 17.066667 42.666667 42.666667v341.333333z m170.666667-170.666667c0 25.6-17.066667 42.666667-42.666667 42.666667h-42.666667v-213.333333c0-72.533333-55.466667-128-128-128H384V256c0-25.6 17.066667-42.666667 42.666667-42.666667h341.333333c25.6 0 42.666667 17.066667 42.666667 42.666667v341.333333z"></path></svg>',
    down: '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M161.28 671.402667c21.76 21.76 48.213333 32.426667 78.933333 32.426666h201.301334l-26.453334 102.4c-4.693333 18.346667-3.84 36.693333 2.56 54.570667 6.4 17.92 17.066667 32.853333 32.426667 43.946667l29.44 22.186666c11.946667 8.96 25.173333 12.8 40.106667 11.52 14.890667-1.28 27.690667-6.826667 37.930666-17.493333l1.28-1.28 188.074667-219.690667c5.12-5.12 9.386667-10.666667 12.373333-17.066666h62.293334c21.333333 0 39.68-8.106667 54.186666-24.746667 13.653333-14.933333 20.48-32.853333 20.48-53.76V249.173333c0-20.906667-6.826667-38.826667-20.48-53.76-14.933333-16.213333-32.853333-24.704-54.186666-24.704H315.690667c-15.786667 0-29.866667 4.266667-43.093334 12.8-13.226667 8.533333-22.613333 20.053333-28.586666 34.56L136.533333 476.501333c-5.546667 13.653333-8.533333 27.733333-8.533333 42.666667v72.490667c0 30.72 11.093333 57.173333 32.853333 78.933333l0.426667 0.853333zM768.213333 256.853333h42.666667v341.248h-42.666667V256.810667zM213.76 519.978667c0-3.413333 0.853333-6.826667 2.133333-9.813334L321.28 256.853333h361.685333v386.901334l-171.050666 200.874666-10.666667-7.68q-2.56-2.56-2.986667-4.266666c-0.426667-1.706667-0.853333-3.413333 0-5.12l53.76-208.981334H240.597333c-7.253333 0-13.653333-2.56-18.773333-7.68a24.832 24.832 0 0 1-7.68-18.346666v-72.533334h-0.426667z"></path></svg>',
    up: '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M862.933333 352.597333a107.52 107.52 0 0 0-78.933333-32.426666h-201.301333l26.453333-102.4c4.693333-18.346667 3.84-36.693333-2.56-54.570667-6.4-17.92-17.066667-32.853333-32.426667-43.946667l-29.44-22.186666c-11.946667-8.96-25.173333-12.8-40.106666-11.52-14.933333 1.28-27.733333 6.826667-37.973334 17.493333l-1.28 1.28L277.333333 324.010667c-5.12 5.12-9.386667 10.666667-12.373333 17.066666h-62.293333c-21.333333 0-39.68 8.106667-54.186667 24.746667-13.653333 14.933333-20.437333 32.853333-20.437333 53.76v355.285333c0 20.906667 6.826667 38.826667 20.48 53.76 14.933333 16.213333 32.853333 24.704 54.186666 24.704h505.856c15.786667 0 29.866667-4.266667 43.093334-12.8 13.226667-8.533333 22.613333-20.053333 28.586666-34.56l107.434667-258.474666c5.546667-13.653333 8.533333-27.733333 8.533333-42.666667v-72.490667c0-30.72-11.093333-57.173333-32.853333-78.933333l-0.426667-0.853333zM255.957333 767.146667H213.333333V425.941333h42.666667v341.248z m554.496-263.168c0 3.413333-0.853333 6.826667-2.133333 9.813333l-105.386667 253.354667H341.290667V380.288l171.093333-200.874667 10.666667 7.68q2.56 2.56 2.986666 4.266667c0.426667 1.706667 0.853333 3.413333 0 5.12l-53.76 208.981333h311.338667c7.253333 0 13.653333 2.56 18.773333 7.68s7.68 11.093333 7.68 18.346667v72.533333h0.426667z"></path></svg>',
    feedback: '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M225.92 742.826667l6.698667-31.957334-16.341334-28.288A339.370667 339.370667 0 0 1 170.666667 512a341.333333 341.333333 0 1 1 341.333333 341.333333c-62.293333 0-120.490667-16.64-170.624-45.610666l-22.784-13.226667-26.325333 2.005333-78.805334 5.930667 12.458667-59.605333zM106.666667 896l88.576-6.656L298.666667 881.578667A424.704 424.704 0 0 0 512 938.666667c235.648 0 426.666667-191.018667 426.666667-426.666667S747.648 85.333333 512 85.333333 85.333333 276.352 85.333333 512c0 77.696 20.778667 150.613333 57.088 213.333333l-17.536 83.712L106.666667 896z m290.133333-371.2a55.466667 55.466667 0 1 1-110.933333 0 55.466667 55.466667 0 0 1 110.933333 0z m115.2 55.466667a55.466667 55.466667 0 1 0 0-110.933334 55.466667 55.466667 0 0 0 0 110.933334z m226.133333-55.466667a55.466667 55.466667 0 1 1-110.933333 0 55.466667 55.466667 0 0 1 110.933333 0z"></path></svg>',
  };

  function iconButton(icon, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = icon;
    b.dataset.tip = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  function renderRefsPanel(refs) {
    const box = document.createElement('div');
    box.className = 'refs-panel';
    for (const r of refs || []) {
      const s = document.createElement('span');
      s.innerHTML = `<b>[${Number(r.seq) || '?'}]</b> `;
      s.append(String(r.title || '来源'));
      box.appendChild(s);
    }
    return box;
  }

  function toggleRefsPanel(bar, refs) {
    const actions = bar.parentElement || bar;
    const old = actions.nextElementSibling;
    if (old && old.classList && old.classList.contains('refs-panel')) { old.remove(); return; }
    if (old && old.classList && old.classList.contains('fbbox')) old.remove();
    actions.insertAdjacentElement('afterend', renderRefsPanel(refs));
  }

  function renderRateBar(bar, jobId, voted, comment, copyText, refs) {
    bar.replaceChildren();
    if (Array.isArray(refs) && refs.length) {
      const rb = iconButton(ACTION_ICONS.refs, '引用');
      rb.classList.add('has-refs');
      rb.addEventListener('click', () => toggleRefsPanel(bar, refs));
      bar.appendChild(rb);
    }
    const copy = iconButton(ACTION_ICONS.copy, '复制');
    copy.addEventListener('click', () => copyReply(copyText, copy));
    bar.appendChild(copy);
    for (const [val, label, icon] of [['up', '有用', ACTION_ICONS.up], ['down', '没用', ACTION_ICONS.down]]) {
      const b = iconButton(icon, label);
      if (voted === val) b.classList.add('sel');
      b.addEventListener('click', () => submitRating(jobId, val, bar, { copyText, comment, refs }));
      bar.appendChild(b);
    }
    const fb = iconButton(ACTION_ICONS.feedback, '反馈');
    if (comment) fb.classList.add('sel');
    fb.addEventListener('click', () => openFeedbackBox(bar, jobId, voted, comment, copyText));
    bar.appendChild(fb);
  }

  async function copyReply(text, btn) {
    const raw = String(text || '').trim();
    const value = raw && cfg.ai_notice !== false ? raw + '\n\n' + AI_NOTICE_TEXT : raw;
    if (!value) return;
    const originalTip = btn.dataset.tip || '复制';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
      else {
        const ta = document.createElement('textarea');
        ta.value = value; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        root.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); ta.remove();
      }
      btn.classList.add('copied');
      btn.dataset.tip = '已复制';
      btn.setAttribute('aria-label', '已复制');
      setTimeout(() => { btn.classList.remove('copied'); btn.dataset.tip = originalTip; btn.setAttribute('aria-label', originalTip); }, 1200);
    } catch {
      btn.dataset.tip = '复制失败';
      btn.setAttribute('aria-label', '复制失败');
      setTimeout(() => { btn.dataset.tip = originalTip; btn.setAttribute('aria-label', originalTip); }, 1200);
    }
  }

  function openFeedbackBox(bar, jobId, voted, comment, copyText) {
    const actions = bar.parentElement || bar;
    const old = actions.nextElementSibling;
    if (old && old.classList && old.classList.contains('fbbox')) { old.remove(); return; }
    if (old && old.classList && old.classList.contains('refs-panel')) old.remove();
    const box = document.createElement('div');
    box.className = 'fbbox';
    const ta = document.createElement('textarea');
    ta.maxLength = 500;
    ta.placeholder = '补充说明这个回答哪里不对、哪里可以更好…';
    ta.value = comment || '';
    const ops = document.createElement('div');
    ops.className = 'fbops';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => box.remove());
    const submit = document.createElement('button');
    submit.type = 'button'; submit.textContent = '提交反馈'; submit.className = 'primary';
    submit.addEventListener('click', () => {
      const next = ta.value.trim();
      if (!next) { ta.focus(); return; }
      submit.classList.add('busy');
      void submitRating(jobId, voted === 'up' || voted === 'down' ? voted : 'note', bar, { comment: next, copyText, box });
    });
    ops.append(cancel, submit);
    box.append(ta, ops);
    actions.insertAdjacentElement('afterend', box);
    ta.focus();
  }

  async function submitRating(jobId, val, bar, opts = {}) {
    try {
      await api(`/chat/${ENTRY}/rate/${jobId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: val, visitor_id: visitorId, ...(opts.comment ? { comment: opts.comment } : {}) }),
      });
      const h = history.find((m) => m.j === jobId);
      if (h) { h.v = val; if (opts.comment) h.c = opts.comment; saveHistory(); }
      if (opts.box) opts.box.remove();
      renderRateBar(bar, jobId, val, opts.comment || opts.comment === '' ? opts.comment : (h && h.c) || '', opts.copyText || '', opts.refs || []);
    } catch {
      const err = document.createElement('span');
      err.className = 'done'; err.textContent = '反馈失败';
      bar.appendChild(err);
      setTimeout(() => err.remove(), 1400);
    }
  }
  let typingEl = null;
  function setTyping(on) {
    if (on && !typingEl) {
      typingEl = document.createElement('div');
      typingEl.className = 'm a typing';
      typingEl.innerHTML = '<i></i><i></i><i></i>';
      msgsEl.appendChild(typingEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    } else if (!on && typingEl) { typingEl.remove(); typingEl = null; }
  }

  function renderHistory() {
    msgsEl.innerHTML = '';
    if (!history.length && cfg.greeting) addMsg('a', cfg.greeting);
    for (const m of history) addMsg(m.r, m.t, m.e, { refs: m.refs, jobId: m.j, voted: m.v, comment: m.c, atts: m.atts });
  }

  async function api(path, opts) {
    let r;
    try {
      r = await fetch(HUB + path, Object.assign({ cache: 'no-store' }, opts || {}));
    } catch (e) {
      const err = new Error('网络连接中断，正在尝试恢复。');
      err.network = true;
      err.cause = e;
      throw err;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.reply || j.error || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return j;
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function isNetworkError(e) {
    const msg = String((e && e.message) || '');
    return !!(e && e.network) || /Failed to fetch|NetworkError|Load failed|连接中断|abort/i.test(msg);
  }
  function publicErrorMessage(e) {
    if (isNetworkError(e)) return '网络连接中断，请稍后重试。';
    return (e && e.message) || '网络异常，请稍后再试。';
  }
  function buildThreadQuery() {
    return `visitor_id=${encodeURIComponent(visitorId)}${threadId ? '&thread_id=' + encodeURIComponent(threadId) : ''}${TICKET ? '&ticket=' + encodeURIComponent(TICKET) : ''}`;
  }
  function mergeServerMessages(msgs) {
    const byJob = {};
    for (const m of history) { if (m.j) byJob[m.j] = { v: m.v, c: m.c, refs: m.refs }; }
    history = msgs.map((m) => ({
      r: m.r, t: m.t, e: false, j: m.j || undefined, atts: m.atts,
      ...(m.j && byJob[m.j] ? { v: byJob[m.j].v, c: byJob[m.j].c, refs: byJob[m.j].refs } : {}),
    }));
    saveHistory();
    renderHistory();
  }
  async function fetchServerMessages() {
    if (!visitorId && !TICKET) return [];
    const r = await api(`/chat/${ENTRY}/thread?${buildThreadQuery()}`, { method: 'GET' });
    return Array.isArray(r.messages) ? r.messages : [];
  }
  async function recoverFromServerHistory(beforeAssistantCount) {
    for (const delay of [0].concat(RECOVER_DELAYS)) {
      if (delay) await sleep(delay);
      try {
        const msgs = await fetchServerMessages();
        const serverAssistantCount = msgs.filter((m) => m && m.r === 'a').length;
        if (serverAssistantCount > beforeAssistantCount) {
          mergeServerMessages(msgs);
          return true;
        }
      } catch { /* 恢复是尽力而为：失败后继续走后续重试/最终提示 */ }
    }
    return false;
  }
  function waitForEventStream(jobId, deadline) {
    if (!jobId || typeof window.EventSource !== 'function') {
      return Promise.reject(new Error('当前浏览器不支持实时消息流。'));
    }
    return new Promise((resolve, reject) => {
      const remain = Math.max(1000, Math.min(5 * 60 * 1000, deadline - Date.now()));
      const es = new EventSource(`${HUB}/chat/${ENTRY}/events/${jobId}?max_wait=${remain}`);
      let settled = false;
      const timer = setTimeout(() => finish(null), remain + 1500);
      function finish(value, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { es.close(); } catch { /* 忽略 */ }
        if (error) reject(error); else resolve(value);
      }
      function parse(ev) {
        try { return JSON.parse((ev && ev.data) || '{}'); }
        catch { return null; }
      }
      es.addEventListener('done', (ev) => finish(parse(ev)));
      es.addEventListener('failed', (ev) => finish(parse(ev)));
      es.addEventListener('timeout', () => finish(null));
      es.onerror = (e) => {
        const err = new Error('网络连接中断，正在尝试恢复。');
        err.network = true;
        err.cause = e;
        finish(null, err);
      };
    });
  }
  function appendAssistantResponse(resp) {
    const reply = resp.done ? (resp.reply || '（无内容）') : '处理时间较长，请稍后回来查看。';
    const refs = Array.isArray(resp.references) ? resp.references : undefined;
    const atts = Array.isArray(resp.attachments) ? resp.attachments : undefined;
    const jobId = resp.done && !resp.error ? resp.job_id : undefined;
    addMsg('a', reply, !!resp.error, { refs, jobId, atts, typing: true });
    history.push({ r: 'a', t: reply, e: !!resp.error, j: jobId, refs, atts }); saveHistory();
  }

  // ---- 附件上传（中枢瘦透传）：选图 → POST /chat/:entry/upload → 中枢 sha256= 签名转发业务上传工具 → 拿回 URL ----
  function renderAttChip() {
    if (!attbarEl) return;
    attbarEl.innerHTML = '';
    if (!pendingAtt) { attbarEl.classList.remove('on'); return; }
    attbarEl.classList.add('on');
    const chip = document.createElement('div');
    chip.className = 'attchip' + (pendingAtt.error ? ' err' : '');
    if (pendingAtt.url && pendingAtt.type === 'image') { const im = document.createElement('img'); im.src = pendingAtt.url; im.alt = ''; chip.appendChild(im); }
    if (pendingAtt.type === 'audio') { const ico = document.createElement('span'); ico.className = 'audio-ico'; ico.textContent = '♪'; chip.appendChild(ico); }
    if (pendingAtt.type === 'file') { const ico = document.createElement('span'); ico.className = 'audio-ico'; ico.textContent = 'FILE'; chip.appendChild(ico); }
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = pendingAtt.uploading ? '上传中… ' + (pendingAtt.name || '') : (pendingAtt.name || (pendingAtt.type === 'audio' ? '语音' : pendingAtt.type === 'file' ? '文件' : '图片'));
    chip.appendChild(nm);
    if (!pendingAtt.uploading) {
      const x = document.createElement('button');
      x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', '移除');
      x.addEventListener('click', clearPendingAtt);
      chip.appendChild(x);
    }
    attbarEl.appendChild(chip);
  }
  function clearPendingAtt() { pendingAtt = null; renderAttChip(); }
  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => rej(fr.error || new Error('读取失败'));
      fr.readAsDataURL(file);
    });
  }
  const MAX_IMAGE_UPLOAD_MB = 6;
  const MAX_AUDIO_UPLOAD_MB = 12;
  const MAX_FILE_UPLOAD_MB = 20;
  const FILE_UPLOAD_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|markdown|json|jsonl|xml|html?|log|yaml|yml|zip|rar|7z)$/i;
  function mimeForFile(file) {
    if (file.type) return file.type;
    const ext = String(file.name || '').toLowerCase().split('.').pop();
    const map = {
      txt: 'text/plain', log: 'text/x-log', ini: 'text/x-ini', conf: 'text/x-conf', md: 'text/markdown', markdown: 'text/markdown',
      csv: 'text/csv', tsv: 'text/tab-separated-values', sql: 'application/sql',
      json: 'application/json', jsonl: 'application/x-ndjson', xml: 'application/xml', html: 'text/html', htm: 'text/html',
      pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
    };
    return map[ext] || '';
  }
  async function doUpload(file, forcedType) {
    if (!file || pending) return;
    const mime = mimeForFile(file);
    const isAudio = forcedType === 'audio' || /^audio\//.test(mime);
    const isImage = !isAudio && /^image\//.test(mime);
    const isFile = !isAudio && !isImage && (
      /^(text\/|application\/(json|x-ndjson|xml|ya?ml|x-yaml|sql|pdf|msword|vnd\.|zip|x-zip-compressed|x-rar-compressed|x-7z-compressed))/.test(mime) ||
      FILE_UPLOAD_EXT.test(file.name || '')
    );
    if (!isImage && !isAudio && !isFile) { pendingAtt = { error: true, name: '仅支持图片、语音或常见文件', type: 'file' }; renderAttChip(); return; }
    const type = isAudio ? 'audio' : isImage ? 'image' : 'file';
    const maxMb = isAudio ? MAX_AUDIO_UPLOAD_MB : isImage ? MAX_IMAGE_UPLOAD_MB : MAX_FILE_UPLOAD_MB;
    const label = isAudio ? '语音' : isImage ? '图片' : '文件';
    if (file.size > maxMb * 1024 * 1024) { pendingAtt = { error: true, name: label + '过大（≤' + maxMb + 'MB）', type }; renderAttChip(); return; }
    pendingAtt = { uploading: true, name: file.name, type }; renderAttChip();
    if (attachBtn) attachBtn.disabled = true;
    if (voiceBtn) voiceBtn.disabled = true;
    try {
      const base64 = (await readAsDataURL(file)).split(',')[1] || '';
      const r = await api(`/chat/${ENTRY}/upload`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mime, data_base64: base64, visitor_id: visitorId, ...(TICKET ? { ticket: TICKET } : {}) }),
      });
      if (!r || !r.url) throw new Error((r && r.error) || '上传失败');
      pendingAtt = { url: r.url, name: r.name || file.name, type: r.type || type };
    } catch (e) {
      pendingAtt = { error: true, name: (e && e.message) || '上传失败，请重试', type };
    } finally {
      if (attachBtn) attachBtn.disabled = false;
      if (voiceBtn) voiceBtn.disabled = false;
      renderAttChip();
    }
  }

  function clipboardImageFiles(e) {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const files = [];
    for (const item of items) {
      if (item.kind !== 'file' || !/^image\//.test(item.type || '')) continue;
      const f = item.getAsFile && item.getAsFile();
      if (!f) continue;
      if (f.name) { files.push(f); continue; }
      const rawExt = (f.type || 'image/png').split('/')[1] || 'png';
      const ext = rawExt.replace(/^jpeg$/i, 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
      files.push(new File([f], `clipboard-${Date.now()}-${files.length + 1}.${ext}`, { type: f.type || 'image/png', lastModified: Date.now() }));
    }
    return files;
  }

  async function handlePaste(e) {
    const images = clipboardImageFiles(e);
    if (!images.length) return;
    e.preventDefault();
    if (!cfg.upload) {
      pendingAtt = { error: true, name: '当前入口未开启图片上传', type: 'image' };
      renderAttChip();
      return;
    }
    if (pending) return;
    await doUpload(images[0]);
  }

  let recorder = null;
  let recordChunks = [];
  function canRecordAudio() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }
  async function toggleRecord() {
    if (pending) return;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordChunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordChunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (voiceBtn) { voiceBtn.classList.remove('rec'); voiceBtn.title = '点击开始/停止录音'; }
        const blob = new Blob(recordChunks, { type: 'audio/webm' });
        if (blob.size) void doUpload(new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }), 'audio');
      };
      recorder.start();
      if (voiceBtn) { voiceBtn.classList.add('rec'); voiceBtn.title = '录音中，点击停止'; }
      setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, 60 * 1000);
    } catch {
      pendingAtt = { error: true, name: '无法访问麦克风', type: 'audio' };
      renderAttChip();
    }
  }

  async function send() {
    const text = inputEl.value.trim();
    const att = (pendingAtt && pendingAtt.url) ? pendingAtt : null; // 只有上传成功（有 url）的才随消息发出
    if ((!text && !att) || pending) return;
    pending = true; sendBtn.disabled = true; if (attachBtn) attachBtn.disabled = true;
    inputEl.value = ''; inputEl.style.height = 'auto'; clearPendingAtt();
    // 发给中枢的消息体 = 用户文字 + 图片 markdown（让 AI 拿到 URL 传给工具）；展示气泡只显示文字，图单独缩略图
    const attMd = att
      ? (att.type === 'audio' ? `[语音：${att.name || '录音'}](${att.url})` : att.type === 'file' ? `[文件：${att.name || '附件'}](${att.url})` : `![${att.name || '图片'}](${att.url})`)
      : '';
    const sentText = att ? (text ? text + '\n\n' + attMd : attMd) : text;
    const dispAtts = att ? [{ type: att.type === 'audio' ? 'audio' : att.type === 'file' ? 'file' : 'image', url: att.url, name: att.name }] : undefined;
    addMsg('u', text, false, { atts: dispAtts });
    history.push({ r: 'u', t: text, atts: dispAtts }); saveHistory();
    setTyping(true);
    let jobId = '';
    const beforeAssistantCount = history.filter((m) => m.r === 'a').length;
    try {
      let resp = await api(`/chat/${ENTRY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: sentText, visitor_id: visitorId, context: collectPageContext(), ...(threadId ? { thread_id: threadId } : {}), ...(TICKET ? { ticket: TICKET } : {}) }),
      });
      jobId = resp.job_id || '';
      if (resp.visitor_id && resp.visitor_id !== visitorId) {
        visitorId = resp.visitor_id;
        try { localStorage.setItem(LS_VISITOR, visitorId); } catch { /* 忽略 */ }
      }
      // 回答流：任务创建后统一走 SSE。thread 只在断线时做服务端总账恢复。
      const deadline = Date.now() + 5 * 60 * 1000;
      if (!resp.done && resp.job_id) {
        const streamed = await waitForEventStream(resp.job_id, deadline);
        if (streamed) resp = streamed;
      }
      setTyping(false);
      appendAssistantResponse(resp);
    } catch (e) {
      setTyping(false);
      if (isNetworkError(e)) {
        if (await recoverFromServerHistory(beforeAssistantCount)) return;
      }
      const msg = publicErrorMessage(e);
      addMsg('a', msg, true);
      history.push({ r: 'a', t: msg, e: true }); saveHistory();
    } finally {
      pending = false; sendBtn.disabled = false;
      if (attachBtn && cfg.upload) attachBtn.disabled = false;
      inputEl.focus();
    }
  }

  // 服务端会话历史回灌：异步完成、断线恢复、跨设备打开时，以服务端总账补齐本地视图。
  // 服务端为权威列表，本地仅保留评价/来源叠加。
  let syncing = false;
  async function syncServerHistory() {
    if (pending || syncing) return;                       // 发送中不动历史，避免抢渲染
    if (!visitorId && !TICKET) return;                    // 无可定位身份：服务端必空，免一趟请求
    syncing = true;
    try {
      const msgs = await fetchServerMessages();
      if (!msgs.length) return;                            // 服务端无历史（新访客/总账关闭）：保留本地
      mergeServerMessages(msgs);                          // 本地按 job_id 留存的评价/来源，回灌后不丢
    } catch { /* 公开面尽力而为：拉不到就用本地，不打断对话 */ }
    finally { syncing = false; }
  }

  wrap.querySelector('.bubble').addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) { inputEl.focus(); void syncServerHistory(); }
  });
  wrap.querySelector('.close').addEventListener('click', () => panel.classList.remove('open'));
  // 开启新对话：换一个 thread_id（已验身份下的平行会话分区键）→ 后端换 scope = 全新 session+总账。
  // thread_id 负责会话分区；visitor_id 负责访客连续性，二者职责分离。
  if (restartBtn) restartBtn.addEventListener('click', () => {
    if (pending) return;                       // 处理中不切，避免半截会话
    threadId = newThreadId();
    try { localStorage.setItem(LS_THREAD, threadId); } catch { /* 隐私模式 */ }
    history = []; saveHistory();
    renderHistory();                           // 回到开场白
    inputEl.focus();
  });

  // ---- 拖动重定位：展开态按住头部空白处拖；气泡+面板作为整块一起移（共用 --off-x/--off-y）；落点记 localStorage ----
  let dragStart = null, dragging = false;
  function onDragMove(e) {
    if (!dragStart) return;
    if (e.buttons === 0) { onDragUp(); return; }          // 鼠标已在窗外松开：稳妥收尾，别卡住
    const dx = e.clientX - dragStart.px, dy = e.clientY - dragStart.py;
    if (!dragging && Math.abs(dx) + Math.abs(dy) < 3) return;  // 位移阈值：区分点击与拖动
    dragging = true;
    if (headEl) headEl.classList.add('dragging');
    const nx = dragStart.ox + (dragStart.isLeft ? dx : -dx); // 右锚：右移=off-x 减；左锚：右移=off-x 加
    const ny = dragStart.oy - dy;                            // off-y 是底距，下移=off-y 减
    const c = clampOff(nx, ny);
    setOff(c.x, c.y);
  }
  function onDragUp() {
    if (dragging) { try { localStorage.setItem(LS_POS, JSON.stringify({ x: curX, y: curY })); } catch { /* 隐私模式 */ } }
    dragStart = null; dragging = false;
    if (headEl) headEl.classList.remove('dragging');
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragUp);
  }
  if (headEl) headEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;                                       // 仅鼠标左键
    if (e.target && e.target.closest && e.target.closest('.ctrls')) return; // 点头部按钮不触发拖动
    if (!panel.classList.contains('open')) return;                   // 仅展开态可拖
    dragStart = { px: e.clientX, py: e.clientY, ox: curX, oy: curY, isLeft: wrap.classList.contains('pos-left') };
    dragging = false;
    e.preventDefault();                                              // 防拖动时选中文字/拖出头像残影
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);
  });
  // ---- 拖边框改尺寸（cfg.resizable 开才生效）：上边把手改高、侧边把手改宽；从拖动起点的尺寸绝对计算（不漂移），夹到与后台同上下限，落点记 LS_SIZE ----
  let rzStart = null;
  function onRzMove(e) {
    if (!rzStart) return;
    if (e.buttons === 0) { onRzUp(); return; }                 // 鼠标已在窗外松开：稳妥收尾
    const dx = e.clientX - rzStart.px, dy = e.clientY - rzStart.py;
    let w = curW, h = curH;
    if (rzStart.ax.indexOf('x') >= 0) w = rzStart.w + (rzStart.isLeft ? dx : -dx); // 右锚：左拖变宽；左锚：右拖变宽
    if (rzStart.ax.indexOf('y') >= 0) h = rzStart.h - dy;                          // 面板锚底：上拖变高
    curW = clampN(w, 280, 720, curW);
    curH = clampN(h, 360, 900, curH);
    applyPanelSize();
  }
  function onRzUp() {
    try { localStorage.setItem(LS_SIZE, JSON.stringify({ w: curW, h: curH })); } catch { /* 隐私模式 */ }
    rzStart = null;
    document.removeEventListener('mousemove', onRzMove);
    document.removeEventListener('mouseup', onRzUp);
  }
  for (const handle of wrap.querySelectorAll('.rz')) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !cfg.resizable) return;
      rzStart = { px: e.clientX, py: e.clientY, w: curW, h: curH, ax: handle.dataset.rz || 'xy', isLeft: wrap.classList.contains('pos-left') };
      e.preventDefault(); e.stopPropagation();                  // 别让父层把它当成移动/选中
      document.addEventListener('mousemove', onRzMove);
      document.addEventListener('mouseup', onRzUp);
    });
  }
  // 访客上次拖出来的尺寸优先于配置默认（仅 resizable 开时；夹到同上下限）；移动端被 !important 全屏规则覆盖，set 了也无害
  function restoreSize() {
    if (!cfg.resizable) return;
    try {
      const s = JSON.parse(localStorage.getItem(LS_SIZE) || 'null');
      if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
        curW = clampN(s.w, 280, 720, curW);
        curH = clampN(s.h, 360, 900, curH);
        applyPanelSize();
      }
    } catch { /* 忽略 */ }
  }

  // 视口变化时把位置夹回可见区（移动端被 !important 全屏规则覆盖，这里 no-op 无害）
  window.addEventListener('resize', () => { const c = clampOff(curX, curY); setOff(c.x, c.y); });

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 90) + 'px';
  });
  inputEl.addEventListener('paste', (e) => { void handlePaste(e); });
  if (attachBtn && fileEl) {
    attachBtn.addEventListener('click', () => { if (!pending && !attachBtn.disabled) fileEl.click(); });
    fileEl.addEventListener('change', () => { const f = fileEl.files && fileEl.files[0]; fileEl.value = ''; if (f) void doUpload(f); });
  }
  if (voiceBtn) voiceBtn.addEventListener('click', () => { if (!pending && !voiceBtn.disabled) void toggleRecord(); });

  // ---- 启动：先拉入口状态与外观；状态未知时 fail-closed，避免展示一个无法工作的入口 ----
  (async () => {
    try {
      const c = await api(`/chat/${ENTRY}/config`, { method: 'GET' });
      cfg = { ...cfg, ...c };
    } catch { host.remove(); return; }
    if (cfg.enabled === false) { host.remove(); return; }
    titleEl.textContent = cfg.title || '在线咨询';
    brandEl.textContent = cfg.powered_by_visible === false ? '' : (cfg.powered_by_text || (cfg.brand ? `由 ${cfg.brand} 驱动` : ''));
    setAccent(cfg.color || '#7a5b3a');
    applyAppearance(); // 尺寸/位置偏移/标题对齐/头像/自定义气泡图标
    // 访客上次拖到的位置优先于配置初始位（夹回当前视口；admin 改了初始位则首次新访客仍用配置）
    try { const s = JSON.parse(localStorage.getItem(LS_POS) || 'null'); if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) { const c = clampOff(s.x, s.y); setOff(c.x, c.y); } } catch { /* 忽略 */ }
    restoreSize(); // 访客上次拖出来的尺寸（resizable 开时）
    if (attachBtn) attachBtn.style.display = cfg.upload ? '' : 'none'; // 路由配了上传操作才露出「添加附件」
    if (voiceBtn) voiceBtn.style.display = cfg.upload && canRecordAudio() ? '' : 'none';
    renderHistory();
    void syncServerHistory();   // 本地先即时上屏，再用服务端总账补齐迟到（审批后等）的回复
    host.style.visibility = 'visible';
    if (AUTO_OPEN) { panel.classList.add('open'); inputEl.focus(); }
  })();
})();
