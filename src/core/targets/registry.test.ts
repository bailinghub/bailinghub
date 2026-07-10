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
