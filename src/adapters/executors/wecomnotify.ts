import { spawn } from 'node:child_process';
import type { AdapterContext, AdapterResult, TargetAdapter } from '../../core/targets/adapter';

/**
 * wecom-notify：⑤送达层企微渠道的**参考实现**（演示「送达类型 X → X-notify 执行器目标」的插座约定）。
 * 开源版不绑定任何私有 CLI。部署方可在 target_config.command 或环境变量
 * BAILING_WECOM_NOTIFY_COMMAND 中配置自己的发送命令。
 * 正文通过 stdin 传入；收件人、渠道和账号通过环境变量传入。正式通知必须所见即所得，不经过 LLM。
 * 输入约定：ctx.input = 已渲染好的消息正文；ctx.metadata.to = 收件人企微 userid；
 * ctx.targetConfig = 路由 delivery 快照（可含 account 指定企微账号）。
 */
export const wecomNotifyAdapter: TargetAdapter = {
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const to = String(ctx.metadata['to'] ?? '').trim();
    if (!to) return { ok: false, output: {}, error: '投递缺少收件人（metadata.to 为空）' };
    if (!ctx.input.trim()) return { ok: false, output: {}, error: '投递正文为空' };

    const command = String(ctx.targetConfig['command'] ?? process.env.BAILING_WECOM_NOTIFY_COMMAND ?? '').trim();
    if (!command) {
      return {
        ok: false,
        output: {},
        error: 'wecom-notify 未配置发送命令：请设置 target_config.command 或 BAILING_WECOM_NOTIFY_COMMAND',
      };
    }
    const account = String(ctx.targetConfig['account'] ?? '').trim();

    return await new Promise<AdapterResult>((resolve) => {
      const t0 = Date.now();
      const child = spawn(command, [], {
        env: {
          ...process.env,
          BAILING_NOTIFY_CHANNEL: 'wecom',
          BAILING_NOTIFY_TO: to,
          BAILING_NOTIFY_ACCOUNT: account,
        },
        shell: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
      child.stdin.end(ctx.input);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, output: {}, error: `无法启动发送命令：${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const usage = { duration_ms: Date.now() - t0 };
        if (timedOut) { resolve({ ok: false, output: {}, usage, error: '投递超时（>30s）' }); return; }
        if (code !== 0) {
          resolve({ ok: false, output: {}, usage, error: `发送命令退出码 ${code}：${(stderr || stdout).slice(0, 300)}` });
          return;
        }
        // 成功输出不含 text 字段：投递任务的"结果"是送达这个事实，不应被 finish() 当作回复再记一遍总账
        resolve({ ok: true, output: { delivered: true, to, channel: 'wecom' }, usage });
      });
    });
  },
};
