// 覆盖：内置 send_message 工具定义（sendToolDef）——必填字段、单/多渠道时 channel 参数的有无与 enum。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToolDef, SEND_TOOL_NAME } from './builtin-tools';

test('sendToolDef：单渠道不暴露 channel 参数（默认用唯一渠道）', () => {
  const def = sendToolDef(['bn-wecom']);
  assert.equal(def.function.name, SEND_TOOL_NAME);
  const props = def.function.parameters['properties'] as Record<string, unknown>;
  assert.ok(props['to'] && props['text'], '必须有 to / text');
  assert.equal(props['channel'], undefined, '单渠道时不应出现 channel 参数');
  assert.deepEqual(def.function.parameters['required'], ['to', 'text']);
});

test('sendToolDef：多渠道时 channel 参数带 enum 限定在白名单内', () => {
  const def = sendToolDef(['bn-wecom', 'ops-wecom']);
  const props = def.function.parameters['properties'] as Record<string, unknown>;
  const channel = props['channel'] as { enum?: string[] } | undefined;
  assert.ok(channel, '多渠道时应暴露 channel 参数');
  assert.deepEqual(channel!.enum, ['bn-wecom', 'ops-wecom'], 'channel 取值必须限定在允许渠道内');
});

test('sendToolDef：描述里列出可用渠道，且说明收件人由大脑指定', () => {
  const def = sendToolDef(['bn-wecom']);
  assert.match(def.function.description, /bn-wecom/);
  assert.match(def.function.description, /收件人由你指定/);
});

test('sendToolDef：支持 files 附件参数（每项 name + content/url）', () => {
  const def = sendToolDef(['bn-wecom']);
  const props = def.function.parameters['properties'] as Record<string, any>;
  assert.ok(props['files'], '应暴露 files 参数');
  assert.equal(props['files'].type, 'array');
  const item = props['files'].items.properties as Record<string, unknown>;
  assert.ok(item['name'] && item['content'] && item['url'], 'files 每项要有 name/content/url');
  assert.deepEqual(props['files'].items.required, ['name']);
});
