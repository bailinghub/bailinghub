// 覆盖：target registry 是目标插座板，不依赖 runtime 单例；配置仓储由组合根显式注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindTargetRegistryStore,
  getTargetDef,
  isRemoteExecutorTarget,
  refreshTargets,
  setTargets,
  targetIsStateless,
  TargetRegistry,
} from './registry';
import type { TargetDef } from '../contracts/types';

const worker: TargetDef = {
  name: 'worker-a',
  kind: 'executor',
  stateless: false,
  needs_project: true,
  timeout_ms: 90_000,
  enabled: true,
};

test('target registry: 通过显式注入的 store 刷新目标', async () => {
  bindTargetRegistryStore({ targets: { async list() { return [worker]; } } });
  await refreshTargets();

  assert.equal(isRemoteExecutorTarget('worker-a'), true);
  assert.equal(getTargetDef('worker-a')?.needs_project, true);
  assert.equal(targetIsStateless('llm'), true);

  bindTargetRegistryStore(null);
  setTargets([]);
});

test('target registry: 刷新失败时保留上一份缓存', async () => {
  bindTargetRegistryStore({ targets: { async list() { return [worker]; } } });
  await refreshTargets();

  bindTargetRegistryStore({ targets: { async list() { throw new Error('db down'); } } });
  await refreshTargets();

  assert.equal(isRemoteExecutorTarget('worker-a'), true);

  bindTargetRegistryStore(null);
  setTargets([]);
});

test('target registry: 两个 Kernel 的同名目标与 store 互不覆盖', async () => {
  const tenantA = new TargetRegistry();
  const tenantB = new TargetRegistry();
  tenantA.bindStore({ targets: { async list() { return [{ ...worker, name: 'shared', needs_project: true }]; } } });
  tenantB.bindStore({ targets: { async list() { return [{ ...worker, name: 'shared', needs_project: false, timeout_ms: 15_000 }]; } } });

  await Promise.all([tenantA.refresh(), tenantB.refresh()]);

  assert.equal(tenantA.get('shared')?.needs_project, true);
  assert.equal(tenantA.timeoutMs('shared', {}), 90_000);
  assert.equal(tenantB.get('shared')?.needs_project, false);
  assert.equal(tenantB.timeoutMs('shared', {}), 15_000);

  tenantA.setTargets([]);
  assert.equal(tenantA.get('shared'), null);
  assert.equal(tenantB.get('shared')?.timeout_ms, 15_000);
});
