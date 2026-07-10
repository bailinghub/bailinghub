import type { AdapterContext, AdapterResult, TargetAdapter } from '../../core/targets/adapter';

function pickOrderNo(input: string): string {
  const m = input.match(/\bSO-\d{4,}\b/i);
  return m ? m[0].toUpperCase() : '';
}

function wantsTicket(input: string): boolean {
  return /工单|售后|人工|跟进|ticket|case/i.test(input);
}

function wantsRefund(input: string): boolean {
  return /退款|退费|refund/i.test(input);
}

function wantsFailure(input: string): boolean {
  return /失败|故障|报错|排障|500|failure|error/i.test(input);
}

function clip(s: string): string {
  return s.length > 1600 ? `${s.slice(0, 1600)}...` : s;
}

/** 本地开源体验用的确定性 inhub 目标：不调用外部 LLM，但完整走工具治理运行面。 */
export const demoAgentAdapter: TargetAdapter = {
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const t0 = Date.now();
    if (!ctx.tools) {
      return {
        ok: false,
        output: {},
        error: 'demo-agent 需要路由挂载 demo 工具源',
      };
    }

    const input = ctx.input || ctx.userQuery || '';
    const orderNo = pickOrderNo(input);
    const lines: string[] = [];
    lines.push('demo-agent 已收到请求，并通过中枢工具治理出口调用业务系统。');

    if (wantsFailure(input)) {
      const failure = await ctx.tools.invoke('demo_failure_probe', {});
      lines.push(`故障演示工具返回：${clip(failure.text)}`);
      return {
        ok: true,
        output: { text: lines.join('\n\n'), tool_calls: 1, demo: true },
        usage: { duration_ms: Date.now() - t0, num_turns: 1 },
        sessionId: ctx.session.sessionId,
      };
    }

    if (wantsRefund(input)) {
      const refund = await ctx.tools.invoke('request_demo_refund', {
        order_no: orderNo || 'SO-1001',
        amount: 199,
        reason: '用户在 demo 中提出退款诉求',
      });
      lines.push(`退款工具返回：${clip(refund.text)}`);
      return {
        ok: true,
        output: { text: lines.join('\n\n'), tool_calls: 1, demo: true },
        usage: { duration_ms: Date.now() - t0, num_turns: 1 },
        sessionId: ctx.session.sessionId,
      };
    }

    const orders = await ctx.tools.invoke('list_demo_orders', orderNo ? { order_no: orderNo } : {});
    lines.push(`订单查询结果：${clip(orders.text)}`);

    let toolCalls = 1;
    if (wantsTicket(input)) {
      const ticket = await ctx.tools.invoke('create_demo_ticket', {
        ...(orderNo ? { order_no: orderNo } : {}),
        title: orderNo ? `跟进订单 ${orderNo}` : '跟进用户售后诉求',
        message: `用户原始诉求：${input.slice(0, 300)}\n\n已查询订单结果：${orders.text.slice(0, 800)}`,
      });
      toolCalls++;
      lines.push(`工单创建结果：${clip(ticket.text)}`);
    }

    return {
      ok: true,
      output: { text: lines.join('\n\n'), tool_calls: toolCalls, demo: true },
      usage: { duration_ms: Date.now() - t0, num_turns: 1 },
      sessionId: ctx.session.sessionId,
    };
  },
};
