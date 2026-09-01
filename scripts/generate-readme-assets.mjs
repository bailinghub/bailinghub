import { readFileSync, writeFileSync } from 'node:fs';

const checkOnly = process.argv.includes('--check');

const themes = {
  light: {
    background: '#ffffff',
    surface: '#f6f8fa',
    surfaceStrong: '#eef2f5',
    text: '#111820',
    muted: '#667085',
    border: '#d0d7de',
    green: '#1f883d',
    greenSoft: '#dafbe1',
    greenText: '#116329',
    accent: '#0969da',
    accentSoft: '#ddf4ff',
    warning: '#9a6700',
    warningSoft: '#fff8c5',
  },
  dark: {
    background: '#0d1117',
    surface: '#161b22',
    surfaceStrong: '#1c242d',
    text: '#f0f6fc',
    muted: '#8b949e',
    border: '#30363d',
    green: '#3fb950',
    greenSoft: '#12261a',
    greenText: '#56d364',
    accent: '#58a6ff',
    accentSoft: '#0c2d4a',
    warning: '#d29922',
    warningSoft: '#3d2f13',
  },
};

const copy = {
  'zh-CN': {
    eyebrow: '从业务触发到可审计送达',
    title: '一条可治理的 Agent 业务链路',
    trigger: '触发面',
    triggers: [
      ['业务后端', 'POST /run', '异步任务 · Token'],
      ['网页访客', '嵌入式聊天组件', 'Origin 白名单 · 身份票据'],
      ['外部平台', '入站渠道', '企微 · 钉钉 · 飞书等'],
    ],
    hub: '百灵中枢',
    hubMeta: '路由、上下文与治理控制面',
    stages: [
      ['身份与幂等', '鉴权 · request_id'],
      ['路由与装配', '总账 · 记忆 · 知识 · 页面'],
      ['目标调度', '按路由选择大脑'],
    ],
    target: '大脑面',
    targets: [
      ['INHUB', 'LLM', '进程内推理 · function calling'],
      ['EXECUTOR', '执行器', '本地 Agent · 第三方 Agent · 慢任务'],
    ],
    governance: '安全治理',
    governanceMeta: '白名单 · 风险分级 · 限流 · 审计 · 审批',
    delivery: '结果送达',
    deliveryMeta: 'Webhook 签名回传 · 渠道回复 · 长轮询',
  },
  en: {
    eyebrow: 'FROM BUSINESS TRIGGER TO AUDITABLE DELIVERY',
    title: 'One governed Agent-to-Business path',
    trigger: 'TRIGGER SURFACE',
    triggers: [
      ['Business backend', 'POST /run', 'Async job · token'],
      ['Web visitor', 'Embedded chat widget', 'Origin allowlist · identity ticket'],
      ['External platform', 'Inbound channel', 'WeCom · DingTalk · Feishu'],
    ],
    hub: 'BailingHub',
    hubMeta: 'Routing, context assembly, and governance control plane',
    stages: [
      ['Identity & idempotency', 'Auth · request_id'],
      ['Route & context', 'Ledger · memory · knowledge · page'],
      ['Target dispatch', 'Select the configured brain'],
    ],
    target: 'BRAIN TARGETS',
    targets: [
      ['INHUB', 'LLM', 'In-process inference · function calling'],
      ['EXECUTOR', 'Executor', 'Local agent · remote agent · long-running work'],
    ],
    governance: 'Governance',
    governanceMeta: 'Allowlist · risk · rate limit · audit · approval',
    delivery: 'Delivery',
    deliveryMeta: 'Signed webhook · channel response · long polling',
  },
};

const productOverviewCopy = {
  'zh-CN': {
    title: '把一句话变成可核对的后台操作',
    desc: '用户通过自然语言提出目标，BailingHub 处理可信身份、能力范围、审批和审计，已有业务系统完成最终授权与真实执行。',
    eyebrow: 'BAILINGHUB · 不只回答问题',
    subtitle: '不用重做商城、SaaS、CRM 或 ERP，也不用让 AI 直连数据库。',
    requestLabel: '01 · 直接说目标',
    requestSystem: '我已连接当前业务后台',
    requestLines: ['查询未发货订单，', '为异常订单创建待处理工单。'],
    requestMeta: '自然语言会话',
    hubLabel: '02 · BAILINGHUB',
    hubTitle: '把目标变成受控业务动作',
    hubSteps: [
      ['可信身份', '这次操作代表谁'],
      ['能力选择', '只使用已接入能力'],
      ['风险与审批', '该停下时先交给人'],
      ['审计留痕', '对话与执行过程可查'],
    ],
    systemLabel: '03 · 已有业务系统',
    systemTitle: '原系统完成真实执行',
    systems: [
      ['商城', '商品 · 订单 · 售后'],
      ['SaaS', '账号 · 门店 · 工单'],
      ['CRM', '客户 · 跟进 · 标签'],
      ['ERP', '库存 · 采购 · 申请'],
    ],
    systemResult: '结果写回原系统，并留下任务记录',
    path: ['自然语言会话', '可信业务身份', '已允许的能力', '原系统权限校验', '真实结果与留痕'],
    boundary: 'BailingHub 管“AI 能够到哪里”，最终权限和业务规则仍由你的系统判断。',
  },
  en: {
    title: 'Turn a request into a verifiable business action',
    desc: 'A user states a goal in natural language. BailingHub applies trusted identity, capability scope, approval, and audit controls, while the existing system keeps final authority and performs the action.',
    eyebrow: 'BAILINGHUB · BEYOND ANSWERS',
    subtitle: 'Keep your commerce, SaaS, CRM, or ERP—and never give an agent raw database access.',
    requestLabel: '01 · STATE THE GOAL',
    requestSystem: 'Connected to the current business system',
    requestLines: ['Find unshipped orders.', 'Create tickets for exceptions.'],
    requestMeta: 'Natural-language request',
    hubLabel: '02 · BAILINGHUB',
    hubTitle: 'Turn the goal into a governed action',
    hubSteps: [
      ['Trusted identity', 'Who this action represents'],
      ['Capability scope', 'Only connected actions'],
      ['Risk & approval', 'Pause when a person must decide'],
      ['Audit trail', 'Conversation and execution evidence'],
    ],
    systemLabel: '03 · EXISTING SYSTEMS',
    systemTitle: 'Your system performs the real action',
    systems: [
      ['Commerce', 'Products · orders'],
      ['SaaS', 'Accounts · tickets'],
      ['CRM', 'Customers · follow-ups'],
      ['ERP', 'Inventory · purchasing'],
    ],
    systemResult: 'Write back to the system of record and keep a task trail',
    path: ['Natural language', 'Trusted identity', 'Allowed capability', 'Business authorization', 'Result & trace'],
    boundary: 'BailingHub controls what the agent can reach. Your system remains the final authority.',
  },
};

const entryPointsCopy = {
  'zh-CN': {
    title: '一个中枢，接住三种 AI 操作入口',
    desc: '网页聊天、本地智能体和 API 自动化入口汇入同一套 BailingHub 身份、路由、工具、审批与审计能力，再调用已有业务系统。',
    eyebrow: 'BAILINGHUB · 多入口，同一套业务能力',
    subtitle: '用户从哪里发起可以不同，权限、业务规则和最终执行仍统一回到原系统。',
    entries: [
      ['网页聊天', '嵌入商城、SaaS 或内部后台', '用户留在当前页面直接说目标'],
      ['本地智能体', '浏览器授权后在桌面 Agent 中办事', '显式选择已授权的业务身份'],
      ['API / 自动化', '后端事件、定时任务或工作流触发', '用稳定接口接入现有自动化'],
    ],
    hub: 'BailingHub',
    hubMeta: '统一的 Agent 业务控制面',
    hubSteps: ['身份绑定', '路由与上下文', '工具范围', '审批与审计'],
    business: '已有业务系统',
    businessMeta: '数据、账号和权限继续归你',
    systems: ['商城', 'SaaS', 'CRM', 'ERP', '内部系统'],
    result: '同一套已接入能力 · 同一条授权边界 · 同一份执行记录',
    boundary: '入口可以更换，业务身份不能由模型伪造，业务权限也不会被绕过。',
  },
  en: {
    title: 'Three agent entry points, one business control plane',
    desc: 'Embedded web chat, local agents, and API automation share the same BailingHub identity, routing, tool, approval, and audit controls before reaching existing business systems.',
    eyebrow: 'BAILINGHUB · MANY ENTRY POINTS, ONE CAPABILITY LAYER',
    subtitle: 'Start from different interfaces while keeping authorization, business rules, and execution in your system.',
    entries: [
      ['Embedded web chat', 'Add it to commerce, SaaS, or internal admin UIs', 'Users state goals without leaving the page'],
      ['Local agent', 'Authorize in browser; use a desktop agent', 'Explicitly select an authorized business identity'],
      ['API / automation', 'Backend events, schedules, or workflows', 'Connect existing automation through a stable API'],
    ],
    hub: 'BailingHub',
    hubMeta: 'One Agent-to-Business control plane',
    hubSteps: ['Identity binding', 'Route & context', 'Tool scope', 'Approval & audit'],
    business: 'Existing systems',
    businessMeta: 'Your data, accounts, and permissions stay yours',
    systems: ['Commerce', 'SaaS', 'CRM', 'ERP', 'Internal'],
    result: 'Shared capabilities · shared authorization boundary · shared execution record',
    boundary: 'Entry points may change. Models cannot invent business identity or bypass business authorization.',
  },
};

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function text(x, y, value, { size = 24, weight = 500, fill, anchor = 'start', family } = {}) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function render(locale, themeName) {
  const c = themes[themeName];
  const t = copy[locale];
  const family = locale === 'zh-CN'
    ? `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`
    : `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const mono = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const parts = [];
  const addText = (x, y, value, options = {}) => parts.push(text(x, y, value, { fill: c.text, family, ...options }));
  const addCard = (x, y, width, height, [label, title, meta]) => {
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${c.surface}" stroke="${c.border}" stroke-width="2"/>`);
    addText(x + 30, y + 36, label.toUpperCase(), { size: 17, weight: 700, fill: c.green });
    addText(x + 30, y + 78, title, { size: 27, weight: 700, family: title.includes('/') ? mono : family });
    addText(x + 30, y + 112, meta, { size: 18, fill: c.muted });
  };

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 960" role="img" aria-labelledby="title desc">`);
  parts.push(`<title id="title">${escapeXml(t.title)}</title>`);
  parts.push(`<desc id="desc">BailingHub architecture overview</desc>`);
  parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${c.green}"/></marker></defs>`);
  parts.push(`<rect width="1600" height="960" fill="${c.background}"/>`);

  addText(100, 62, t.eyebrow, { size: 17, weight: 700, fill: c.green });
  addText(100, 106, t.title, { size: 34, weight: 750 });
  addText(100, 155, t.trigger, { size: 16, weight: 700, fill: c.muted });

  addCard(100, 180, 420, 130, t.triggers[0]);
  addCard(590, 180, 420, 130, t.triggers[1]);
  addCard(1080, 180, 420, 130, t.triggers[2]);

  for (const x of [310, 800, 1290]) {
    parts.push(`<path d="M ${x} 310 V 350" fill="none" stroke="${c.green}" stroke-width="3" marker-end="url(#arrow)"/>`);
  }

  parts.push(`<rect x="190" y="365" width="1220" height="220" fill="${c.greenSoft}" stroke="${c.green}" stroke-width="3"/>`);
  addText(230, 410, t.hub, { size: 29, weight: 800, fill: c.greenText });
  addText(230, 444, t.hubMeta, { size: 19, fill: c.muted });

  const stageX = [230, 625, 1020];
  t.stages.forEach((stage, index) => {
    const x = stageX[index];
    parts.push(`<rect x="${x}" y="475" width="350" height="78" fill="${c.background}" stroke="${c.border}" stroke-width="2"/>`);
    addText(x + 22, 508, stage[0], { size: 21, weight: 700 });
    addText(x + 22, 536, stage[1], { size: 16, fill: c.muted, family: stage[1].includes('request_id') ? mono : family });
    if (index < 2) parts.push(`<path d="M ${x + 350} 514 H ${x + 380}" fill="none" stroke="${c.green}" stroke-width="3" marker-end="url(#arrow)"/>`);
  });

  parts.push(`<path d="M 800 585 V 625" fill="none" stroke="${c.green}" stroke-width="3" marker-end="url(#arrow)"/>`);
  addText(190, 640, t.target, { size: 16, weight: 700, fill: c.muted });
  addCard(190, 660, 580, 118, t.targets[0]);
  addCard(830, 660, 580, 118, t.targets[1]);

  parts.push(`<path d="M 480 778 V 814 H 800" fill="none" stroke="${c.green}" stroke-width="3"/>`);
  parts.push(`<path d="M 1120 778 V 814 H 800 V 830" fill="none" stroke="${c.green}" stroke-width="3" marker-end="url(#arrow)"/>`);
  parts.push(`<rect x="190" y="842" width="700" height="74" fill="${c.surfaceStrong}" stroke="${c.border}" stroke-width="2"/>`);
  addText(220, 877, t.governance, { size: 23, weight: 750, fill: c.greenText });
  addText(220, 902, t.governanceMeta, { size: 17, fill: c.muted });
  parts.push(`<path d="M 890 879 H 930" fill="none" stroke="${c.green}" stroke-width="3" marker-end="url(#arrow)"/>`);
  parts.push(`<rect x="940" y="842" width="470" height="74" fill="${c.surface}" stroke="${c.border}" stroke-width="2"/>`);
  addText(970, 877, t.delivery, { size: 23, weight: 750 });
  addText(970, 902, t.deliveryMeta, { size: 16, fill: c.muted });

  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

function renderProductOverview(locale, themeName) {
  const c = themes[themeName];
  const t = productOverviewCopy[locale];
  const family = locale === 'zh-CN'
    ? `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`
    : `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const mono = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const parts = [];
  const addText = (x, y, value, options = {}) => parts.push(text(x, y, value, { fill: c.text, family, ...options }));
  const addPanel = (x, y, width, height, { fill = c.surface, stroke = c.border, radius = 18, strokeWidth = 2 } = {}) => {
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`);
  };

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" role="img" aria-labelledby="title desc">`);
  parts.push(`<title id="title">${escapeXml(t.title)}</title>`);
  parts.push(`<desc id="desc">${escapeXml(t.desc)}</desc>`);
  parts.push(`<defs><marker id="overview-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${c.green}"/></marker></defs>`);
  parts.push(`<rect width="1600" height="900" fill="${c.background}"/>`);
  parts.push(`<path d="M 0 0 H 1600 V 7 H 0 Z" fill="${c.green}"/>`);

  addText(80, 55, t.eyebrow, { size: 17, weight: 750, fill: c.green, family: mono });
  addText(80, 108, t.title, { size: locale === 'zh-CN' ? 46 : 44, weight: 800 });
  addText(80, 148, t.subtitle, { size: 21, fill: c.muted });

  addPanel(80, 185, 410, 455);
  addText(110, 225, t.requestLabel, { size: 17, weight: 750, fill: c.green, family: mono });
  addPanel(110, 255, 350, 315, { fill: c.background, radius: 14 });
  parts.push(`<circle cx="132" cy="278" r="5" fill="${c.green}"/>`);
  addText(148, 284, t.requestSystem, { size: locale === 'zh-CN' ? 16 : 15, weight: 650, fill: c.muted });
  addPanel(130, 315, 270, 58, { fill: c.surfaceStrong, stroke: c.surfaceStrong, radius: 15, strokeWidth: 1 });
  addText(150, 351, locale === 'zh-CN' ? '今天先处理哪些订单？' : 'What should I handle today?', { size: 17, fill: c.muted });
  addPanel(160, 400, 270, 104, { fill: c.greenSoft, stroke: c.green, radius: 15, strokeWidth: 2 });
  addText(180, 439, t.requestLines[0], { size: locale === 'zh-CN' ? 19 : 17, weight: 700, fill: c.greenText });
  addText(180, 470, t.requestLines[1], { size: locale === 'zh-CN' ? 19 : 17, weight: 700, fill: c.greenText });
  parts.push(`<rect x="130" y="532" width="210" height="10" rx="5" fill="${c.surfaceStrong}"/>`);
  addText(110, 610, t.requestMeta, { size: 17, weight: 700, fill: c.muted });

  parts.push(`<path d="M 490 412 H 550" fill="none" stroke="${c.green}" stroke-width="4" marker-end="url(#overview-arrow)"/>`);

  addPanel(565, 185, 470, 455, { fill: c.greenSoft, stroke: c.green, radius: 18, strokeWidth: 3 });
  addText(595, 225, t.hubLabel, { size: 17, weight: 750, fill: c.greenText, family: mono });
  addText(595, 265, t.hubTitle, { size: locale === 'zh-CN' ? 25 : 23, weight: 800 });
  t.hubSteps.forEach((step, index) => {
    const y = 294 + index * 78;
    addPanel(595, y, 410, 64, { fill: c.background, radius: 12 });
    parts.push(`<rect x="611" y="${y + 17}" width="30" height="30" rx="8" fill="${index === 2 ? c.warningSoft : c.accentSoft}"/>`);
    addText(626, y + 39, String(index + 1), { size: 15, weight: 800, fill: index === 2 ? c.warning : c.accent, anchor: 'middle', family: mono });
    addText(657, y + 27, step[0], { size: 19, weight: 750 });
    addText(657, y + 50, step[1], { size: locale === 'zh-CN' ? 15 : 14, fill: c.muted });
  });

  parts.push(`<path d="M 1035 412 H 1095" fill="none" stroke="${c.green}" stroke-width="4" marker-end="url(#overview-arrow)"/>`);

  addPanel(1110, 185, 410, 455);
  addText(1140, 225, t.systemLabel, { size: 17, weight: 750, fill: c.green, family: mono });
  addText(1140, 265, t.systemTitle, { size: locale === 'zh-CN' ? 25 : 22, weight: 800 });
  t.systems.forEach((system, index) => {
    const x = 1140 + (index % 2) * 180;
    const y = 295 + Math.floor(index / 2) * 112;
    addPanel(x, y, 160, 92, { fill: index === 0 ? c.accentSoft : c.background, radius: 12 });
    addText(x + 18, y + 35, system[0], { size: 20, weight: 800, fill: index === 0 ? c.accent : c.text });
    addText(x + 18, y + 65, system[1], { size: locale === 'zh-CN' ? 14 : 13, fill: c.muted });
  });
  addPanel(1140, 526, 340, 76, { fill: c.greenSoft, stroke: c.green, radius: 12 });
  addText(1310, 558, locale === 'zh-CN' ? '执行完成' : 'ACTION COMPLETE', { size: 16, weight: 800, fill: c.greenText, anchor: 'middle', family: mono });
  addText(1310, 584, t.systemResult, { size: locale === 'zh-CN' ? 14 : 12, fill: c.muted, anchor: 'middle' });

  addPanel(80, 685, 1440, 112, { fill: c.surfaceStrong, radius: 16 });
  t.path.forEach((stage, index) => {
    const x = 115 + index * 287;
    parts.push(`<circle cx="${x + 20}" cy="730" r="20" fill="${index === t.path.length - 1 ? c.green : c.background}" stroke="${c.green}" stroke-width="2"/>`);
    addText(x + 20, 736, String(index + 1), { size: 15, weight: 800, fill: index === t.path.length - 1 ? c.background : c.greenText, anchor: 'middle', family: mono });
    addText(x + 50, 736, stage, { size: locale === 'zh-CN' ? 17 : 15, weight: 700 });
    if (index < t.path.length - 1) {
      parts.push(`<path d="M ${x + 242} 730 H ${x + 272}" fill="none" stroke="${c.green}" stroke-width="3" marker-end="url(#overview-arrow)"/>`);
    }
  });
  addText(800, 770, locale === 'zh-CN' ? '从一句话到真实业务结果，每一步都能回头核对' : 'From one request to a real business result, every step remains verifiable', { size: locale === 'zh-CN' ? 17 : 15, fill: c.muted, anchor: 'middle' });
  addText(800, 854, t.boundary, { size: locale === 'zh-CN' ? 18 : 17, weight: 650, fill: c.muted, anchor: 'middle' });

  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

function renderEntryPoints(locale, themeName) {
  const c = themes[themeName];
  const t = entryPointsCopy[locale];
  const family = locale === 'zh-CN'
    ? `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`
    : `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const mono = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const parts = [];
  const addText = (x, y, value, options = {}) => parts.push(text(x, y, value, { fill: c.text, family, ...options }));
  const addPanel = (x, y, width, height, { fill = c.surface, stroke = c.border, radius = 18, strokeWidth = 2 } = {}) => {
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`);
  };

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" role="img" aria-labelledby="title desc">`);
  parts.push(`<title id="title">${escapeXml(t.title)}</title>`);
  parts.push(`<desc id="desc">${escapeXml(t.desc)}</desc>`);
  parts.push(`<defs><marker id="entry-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${c.green}"/></marker></defs>`);
  parts.push(`<rect width="1600" height="900" fill="${c.background}"/>`);
  parts.push(`<path d="M 0 0 H 1600 V 7 H 0 Z" fill="${c.green}"/>`);

  addText(80, 55, t.eyebrow, { size: 17, weight: 750, fill: c.green, family: mono });
  addText(80, 108, t.title, { size: locale === 'zh-CN' ? 46 : 43, weight: 800 });
  addText(80, 148, t.subtitle, { size: locale === 'zh-CN' ? 20 : 19, fill: c.muted });

  t.entries.forEach((entry, index) => {
    const y = 185 + index * 205;
    addPanel(80, y, 430, 155, { fill: index === 1 ? c.accentSoft : c.surface, stroke: index === 1 ? c.accent : c.border, radius: 16 });
    parts.push(`<circle cx="128" cy="${y + 48}" r="25" fill="${index === 1 ? c.accent : c.green}"/>`);
    if (index === 0) {
      parts.push(`<path d="M 114 ${y + 39} h 28 v 17 h -13 l -8 7 v -7 h -7 z" fill="none" stroke="${c.background}" stroke-width="3" stroke-linejoin="round"/>`);
    } else if (index === 1) {
      parts.push(`<rect x="113" y="${y + 34}" width="30" height="21" rx="3" fill="none" stroke="${c.background}" stroke-width="3"/><path d="M 123 ${y + 61} h 10 M 128 ${y + 55} v 6" stroke="${c.background}" stroke-width="3" stroke-linecap="round"/>`);
    } else {
      addText(128, y + 55, '</>', { size: 14, weight: 800, fill: c.background, anchor: 'middle', family: mono });
    }
    addText(170, y + 43, entry[0], { size: locale === 'zh-CN' ? 23 : 21, weight: 800 });
    addText(170, y + 77, entry[1], { size: locale === 'zh-CN' ? 17 : 15, weight: 650, fill: c.muted });
    addText(110, y + 123, entry[2], { size: locale === 'zh-CN' ? 16 : 14, fill: c.muted });
  });

  parts.push(`<path d="M 510 262 C 560 262 560 330 610 330" fill="none" stroke="${c.green}" stroke-width="4" marker-end="url(#entry-arrow)"/>`);
  parts.push(`<path d="M 510 467 C 560 467 560 450 610 450" fill="none" stroke="${c.green}" stroke-width="4" marker-end="url(#entry-arrow)"/>`);
  parts.push(`<path d="M 510 672 C 560 672 560 570 610 570" fill="none" stroke="${c.green}" stroke-width="4" marker-end="url(#entry-arrow)"/>`);

  addPanel(610, 235, 440, 430, { fill: c.greenSoft, stroke: c.green, radius: 20, strokeWidth: 3 });
  addText(640, 282, t.hub, { size: 31, weight: 850, fill: c.greenText });
  addText(640, 316, t.hubMeta, { size: locale === 'zh-CN' ? 17 : 16, fill: c.muted });
  t.hubSteps.forEach((step, index) => {
    const x = 640 + (index % 2) * 190;
    const y = 355 + Math.floor(index / 2) * 125;
    addPanel(x, y, 170, 96, { fill: c.background, radius: 13 });
    parts.push(`<rect x="${x + 18}" y="${y + 18}" width="28" height="28" rx="7" fill="${index === 3 ? c.warningSoft : c.accentSoft}"/>`);
    addText(x + 32, y + 38, String(index + 1), { size: 14, weight: 800, fill: index === 3 ? c.warning : c.accent, anchor: 'middle', family: mono });
    addText(x + 18, y + 74, step, { size: locale === 'zh-CN' ? 18 : 15, weight: 750 });
  });
  addText(830, 625, locale === 'zh-CN' ? '路由、知识、工具和记录只维护一套' : 'Maintain routes, knowledge, tools, and records once', { size: locale === 'zh-CN' ? 16 : 14, fill: c.muted, anchor: 'middle' });

  parts.push(`<path d="M 1050 450 H 1145" fill="none" stroke="${c.green}" stroke-width="4" marker-end="url(#entry-arrow)"/>`);

  addPanel(1160, 235, 360, 430);
  addText(1190, 282, t.business, { size: locale === 'zh-CN' ? 27 : 25, weight: 800 });
  addText(1190, 316, t.businessMeta, { size: locale === 'zh-CN' ? 16 : 14, fill: c.muted });
  t.systems.forEach((system, index) => {
    const row = Math.floor(index / 2);
    const x = 1190 + (index % 2) * 150;
    const y = 360 + row * 78;
    const width = index === 4 ? 280 : 130;
    addPanel(index === 4 ? 1190 : x, y, width, 56, { fill: index === 4 ? c.greenSoft : c.background, stroke: index === 4 ? c.green : c.border, radius: 12 });
    addText((index === 4 ? 1190 : x) + width / 2, y + 36, system, { size: locale === 'zh-CN' ? 18 : 16, weight: 750, fill: index === 4 ? c.greenText : c.text, anchor: 'middle' });
  });
  addText(1340, 620, locale === 'zh-CN' ? '最终授权 · 真实执行 · 原生数据' : 'Final authority · real execution · system data', { size: locale === 'zh-CN' ? 15 : 13, weight: 650, fill: c.muted, anchor: 'middle' });

  addPanel(610, 705, 910, 74, { fill: c.surfaceStrong, radius: 14 });
  parts.push(`<circle cx="650" cy="742" r="19" fill="${c.green}"/>`);
  parts.push(`<path d="M 640 742 l 7 7 14 -16" fill="none" stroke="${c.background}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);
  addText(690, 749, t.result, { size: locale === 'zh-CN' ? 17 : 15, weight: 700 });
  addText(800, 854, t.boundary, { size: locale === 'zh-CN' ? 18 : 16, weight: 650, fill: c.muted, anchor: 'middle' });

  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

const outputs = [
  ['assets/architecture-overview.zh-CN.svg', () => render('zh-CN', 'light')],
  ['assets/architecture-overview.zh-CN-dark.svg', () => render('zh-CN', 'dark')],
  ['assets/architecture-overview.en.svg', () => render('en', 'light')],
  ['assets/architecture-overview.en-dark.svg', () => render('en', 'dark')],
  ['assets/readme-product-overview.zh-CN.svg', () => renderProductOverview('zh-CN', 'light')],
  ['assets/readme-product-overview.zh-CN-dark.svg', () => renderProductOverview('zh-CN', 'dark')],
  ['assets/readme-product-overview.en.svg', () => renderProductOverview('en', 'light')],
  ['assets/readme-product-overview.en-dark.svg', () => renderProductOverview('en', 'dark')],
  ['assets/readme-entry-points.zh-CN.svg', () => renderEntryPoints('zh-CN', 'light')],
  ['assets/readme-entry-points.zh-CN-dark.svg', () => renderEntryPoints('zh-CN', 'dark')],
  ['assets/readme-entry-points.en.svg', () => renderEntryPoints('en', 'light')],
  ['assets/readme-entry-points.en-dark.svg', () => renderEntryPoints('en', 'dark')],
];

for (const [file, build] of outputs) {
  const expected = build();
  if (checkOnly) {
    const actual = readFileSync(file, 'utf8');
    if (actual !== expected) {
      console.error(`${file} is stale. Run npm run assets:generate.`);
      process.exitCode = 1;
    }
  } else {
    writeFileSync(file, expected);
  }
}

if (!process.exitCode) {
  console.log(`✓ README assets ${checkOnly ? 'are current' : 'generated'} (${outputs.length} files)`);
}
