import assert from 'node:assert/strict';
import test from 'node:test';
import { compileOpenApiTools } from '../core/contracts/openapi-tools';
import type { ToolDefinition } from '../core/contracts/tool-definition';
import type { Route, ToolProvider } from '../core/contracts/types';
import type { AllowedToolContext } from './tool-context';
import { agentToolCatalogRevisionFor } from './agent-tool-invocations';

test('same raw spec gets a new catalog revision when compiler discovery or guidance projection changes', () => {
  const spec = JSON.stringify({ paths: { '/page': { get: { operationId: 'page_get', summary: '读取页面', description: '必须先核对页面绑定。',
    'x-agent-capability': { enabled: true, scope: 'page.read' } } } } });
  const tool = compileOpenApiTools(spec).tools[0]!;
  const provider: ToolProvider = { name: 'pages', enabled: true, base_url: 'https://pages.invalid', secret: 'not-part-of-revision',
    spec_source: 'inline', spec_json: spec, timeout_ms: 1000, rate_limit_per_min: 0, auto_refresh_min: 0, log_payload: false };
  const route: Route = { route_key: 'page-agent', name: 'Pages', enabled: true, target: 'llm', target_config: {}, profile: 'general',
    session_policy: 'new', tools: { sources: [{ provider: provider.name, allow: ['*'] }], agent_direct: { enabled: true } } };
  const revision = (compiled: ToolDefinition) => {
    const context: AllowedToolContext = { allowed: [compiled], sources: [{ provider, allowed: [compiled],
      sourceCfg: { provider: provider.name, allow: ['*'] }, onBehalfOf: 't1:u1', lockedBySubject: 0 }], toolsCfg: route.tools!, lockedBySubject: 0 };
    return agentToolCatalogRevisionFor(route, context);
  };
  const current = revision(tool);
  assert.equal(revision(structuredClone(tool)), current, 'same raw spec and same compiled output stay stable');
  const historical = { ...tool, usageGuidance: undefined, descriptionTruncated: undefined };
  assert.notEqual(revision(historical), current, 'the same spec compiled before detail preservation must not reuse the new revision');
  assert.notEqual(revision({ ...tool, description: '读取页面并核对绑定' }), current, 'public short-description changes invalidate the catalog');
  assert.notEqual(revision({ ...tool, descriptionTruncated: true }), current, 'public truncation flags participate in the revision');
  assert.notEqual(revision({ ...tool, usageGuidance: { ...tool.usageGuidance!, text: '其他指导', sourceChars: 4, sourceBytes: 12 } }), current,
    'full guidance changes invalidate detail caches even when public summaries remain identical');
  assert.equal(provider.spec_json, spec, 'all compiler-output variants use byte-identical source spec');
});
