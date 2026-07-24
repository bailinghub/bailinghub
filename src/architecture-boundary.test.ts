import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');
const adaptersDir = join(srcDir, 'adapters');
const coreDir = join(srcDir, 'core');
const servicesDir = join(srcDir, 'services');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }).sort();
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const specifier = match[1] ?? match[2];
    if (specifier) specs.push(specifier);
  }
  return specs;
}

function resolveLocalImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(file), specifier);
  const candidates = [base, `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

function dependencyViolations(dir: string, forbidden: RegExp[]): string[] {
  const violations: string[] = [];
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveLocalImport(file, specifier);
      if (!resolved || !resolved.startsWith(srcDir)) continue;
      const target = relative(srcDir, resolved);
      if (forbidden.some((rule) => rule.test(target))) {
        violations.push(`${relative(srcDir, file)} -> ${target}`);
      }
    }
  }
  return violations;
}

test('architecture boundary: core does not depend on app, routes, adapters, services, or infrastructure', () => {
  assert.deepEqual(dependencyViolations(coreDir, [
    /^app\//,
    /^routes\//,
    /^adapters\//,
    /^services\//,
    /^infrastructure\//,
    /^server\.ts$/,
    /^executor\.ts$/,
  ]), []);
});

test('architecture boundary: adapters do not depend on app, HTTP routes, services, or infrastructure', () => {
  assert.deepEqual(dependencyViolations(adaptersDir, [
    /^app\//,
    /^routes\//,
    /^services\//,
    /^infrastructure\//,
    /^server\.ts$/,
    /^executor\.ts$/,
  ]), []);
});

test('architecture boundary: services do not depend on app, HTTP routes, adapters, or server entrypoints', () => {
  assert.deepEqual(dependencyViolations(servicesDir, [
    /^app\//,
    /^routes\//,
    /^adapters\//,
    /^server\.ts$/,
    /^executor\.ts$/,
  ]), []);
});

test('architecture boundary: app/http.ts stays free of runtime singletons', () => {
  const file = join(srcDir, 'app', 'http.ts');
  assert.deepEqual(dependencyViolations(dirname(file), [
    /^app\/runtime\.ts$/,
  ]).filter((violation) => violation.startsWith('app/http.ts -> ')), []);
});

test('architecture boundary: injectable HTTP/auth/tool modules stay free of runtime singletons', () => {
  const violations = [
    ...dependencyViolations(join(srcDir, 'routes'), [/^app\/runtime\.ts$/])
      .filter((violation) => /^(routes\/public|routes\/private|routes\/admin|routes\/admin-runtime|routes\/admin-access|routes\/admin-chat|routes\/admin-dispatch-config|routes\/admin-infra|routes\/admin-kb|routes\/admin-tool-providers|routes\/kb|routes\/run|routes\/send|routes\/executor|routes\/approvals|routes\/chat|routes\/wecom)\.ts -> /.test(violation)),
    ...dependencyViolations(join(srcDir, 'app'), [/^app\/runtime\.ts$/])
      .filter((violation) => /^(app\/admin-bootstrap|app\/auth|app\/engine|app\/runtime-context|app\/runtime-lifecycle|app\/tools-runtime|app\/tool-proxy|app\/channels|app\/outbound|app\/delivery|app\/monitor|app\/tool-approvals|app\/tool-assembly|app\/tool-specs|app\/builtin-tools|app\/tool-context)\.ts -> /.test(violation)),
  ];
  assert.deepEqual(violations, []);
});
