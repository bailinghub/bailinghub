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

const outputs = [
  ['assets/architecture-overview.zh-CN.svg', 'zh-CN', 'light'],
  ['assets/architecture-overview.zh-CN-dark.svg', 'zh-CN', 'dark'],
  ['assets/architecture-overview.en.svg', 'en', 'light'],
  ['assets/architecture-overview.en-dark.svg', 'en', 'dark'],
];

for (const [file, locale, theme] of outputs) {
  const expected = render(locale, theme);
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
  console.log(`✓ README architecture assets ${checkOnly ? 'are current' : 'generated'} (${outputs.length} files)`);
}
