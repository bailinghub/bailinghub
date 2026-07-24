import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';

const root = process.cwd();
const findings = [];

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const st = statSync(file);
    if (st.isDirectory()) walk(file, predicate, out);
    else if (predicate(file)) out.push(file);
  }
  return out;
}

function rel(file) {
  return file.slice(root.length + 1);
}

function stripTarget(raw) {
  return raw.trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
}

function isExternal(target) {
  return /^(?:https?:)?\/\//i.test(target) || /^(?:mailto|tel|javascript):/i.test(target);
}

function isPlaceholder(target) {
  return !target || target === '#' || target.includes('${') || target.includes('<') || target.includes('>') || target.includes('...') || target.includes('…') || target === 'url';
}

function sitePathToFile(pathname) {
  if (pathname === '/install.sh') return 'scripts/install.sh';
  if (pathname.startsWith('/schemas/')) return `schemas/${pathname.slice('/schemas/'.length)}`;
  if (pathname.startsWith('/connect/')) return `web/connect/${pathname.slice('/connect/'.length)}`;
  return null;
}

function resolveTarget(sourceRel, target) {
  const clean = stripTarget(target);
  if (isExternal(clean) || isPlaceholder(clean)) return null;
  if (clean.startsWith('/')) return sitePathToFile(clean);
  return normalize(join(dirname(sourceRel), clean)).replace(/\\/g, '/');
}

function targetExists(targetRel) {
  if (!targetRel) return true;
  const abs = join(root, targetRel);
  if (existsSync(abs)) return true;
  if (!extname(abs) && existsSync(`${abs}.md`)) return true;
  if (!extname(abs) && existsSync(`${abs}.html`)) return true;
  return false;
}

function extractLinks(text) {
  const links = [];
  for (const match of text.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) links.push(match[1]);
  for (const match of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) links.push(match[1]);
  return links;
}

const files = [
  join(root, 'README.md'),
  join(root, 'README.en.md'),
  ...walk(join(root, 'docs'), (file) => file.endsWith('.md')),
];

const englishCompanions = {
  'README.md': 'README.en.md',
  'docs/README.md': 'docs/README.en.md',
  'docs/ARCHITECTURE.md': 'docs/ARCHITECTURE.en.md',
  'docs/CHANNELS.md': 'docs/CHANNELS.en.md',
  'docs/CHANGELOG.md': 'docs/CHANGELOG.en.md',
  'docs/CONTRACT.md': 'docs/CONTRACT.en.md',
  'docs/DEMO.md': 'docs/DEMO.en.md',
  'docs/PIPELINE.md': 'docs/PIPELINE.en.md',
  'docs/OPERATIONS.md': 'docs/OPERATIONS.en.md',
  'docs/QUICKSTART.md': 'docs/QUICKSTART.en.md',
  'docs/RELEASE_NOTES_v0.1.0.md': 'docs/RELEASE_NOTES_v0.1.0.en.md',
  'docs/RELEASE_NOTES_v0.1.1.md': 'docs/RELEASE_NOTES_v0.1.1.en.md',
  'docs/RELEASE_NOTES_v0.1.2.md': 'docs/RELEASE_NOTES_v0.1.2.en.md',
  'docs/RELEASE_NOTES_v0.1.3.md': 'docs/RELEASE_NOTES_v0.1.3.en.md',
  'docs/RELEASE_NOTES_v0.1.4.md': 'docs/RELEASE_NOTES_v0.1.4.en.md',
  'docs/RELEASE_NOTES_v0.1.5.md': 'docs/RELEASE_NOTES_v0.1.5.en.md',
  'docs/RELEASE_NOTES_v0.1.6.md': 'docs/RELEASE_NOTES_v0.1.6.en.md',
  'docs/RELEASE_NOTES_v0.1.7.md': 'docs/RELEASE_NOTES_v0.1.7.en.md',
  'docs/RELEASE_NOTES_v0.1.8.md': 'docs/RELEASE_NOTES_v0.1.8.en.md',
  'docs/RELEASE_NOTES_v0.1.9.md': 'docs/RELEASE_NOTES_v0.1.9.en.md',
  'docs/TOOLS_DESIGN.md': 'docs/TOOLS_DESIGN.en.md',
  'docs/TOOLS_MODEL.md': 'docs/TOOLS_MODEL.en.md',
  'docs/AI友好工具设计指南.md': 'docs/AI_FRIENDLY_TOOLS.en.md',
  'docs/兼容性与升级.md': 'docs/COMPATIBILITY.en.md',
  'docs/第三方对接指南.md': 'docs/INTEGRATION.en.md',
  'docs/user-guide/README.md': 'docs/user-guide/README.en.md',
  'docs/user-guide/overview.md': 'docs/user-guide/overview.en.md',
  'docs/user-guide/concepts.md': 'docs/user-guide/concepts.en.md',
  'docs/user-guide/console-map.md': 'docs/user-guide/console-map.en.md',
  'docs/user-guide/scenarios.md': 'docs/user-guide/scenarios.en.md',
  'brain/README.md': 'brain/README.en.md',
  'sql/README.md': 'sql/README.en.md',
};

for (const [source, companion] of Object.entries(englishCompanions)) {
  if (!existsSync(join(root, source))) findings.push(`missing public doc source ${source}`);
  if (!existsSync(join(root, companion))) findings.push(`${source}: missing English companion ${companion}`);
}

for (const file of files) {
  const sourceRel = rel(file);
  const text = readFileSync(file, 'utf8');
  for (const link of extractLinks(text)) {
    const targetRel = resolveTarget(sourceRel, link);
    if (targetRel && !targetExists(targetRel)) {
      findings.push(`${sourceRel}: broken local link ${link} -> ${targetRel}`);
    }
  }
}

if (findings.length) {
  console.error('Doc link check failed:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log(`✓ doc link check passed (${files.length} files inspected)`);
