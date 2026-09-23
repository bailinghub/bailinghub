import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const url =
  process.env.TOKEN_CONSOLE_URL || "http://127.0.0.1:4437/console/usage";
const output =
  process.env.TOKEN_CONSOLE_EVIDENCE || "/tmp/bailing-token-console";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
let permissions = ["*"];
const errors = [],
  unexpected = [],
  posts = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (
    m.type() === "warning" &&
    m.text().includes("Failed to resolve component")
  )
    errors.push(m.text());
});
const accounts = [
  {
    id: "account-synthetic",
    label: "合成验收账户",
    kind: "personal",
    state: "active",
  },
];
const services = [
  {
    id: "general",
    label: "通用模型",
    revision: 1,
    state: "active",
    config: {
      credential: "synthetic-provider",
      model: "synthetic-chat",
      providerScope: "synthetic-provider",
      maxInputBytes: 8388608,
      maxOutputTokens: 8192,
      timeoutMs: 120000,
    },
  },
  {
    id: "reasoning",
    label: "推理模型",
    revision: 1,
    state: "active",
    config: {
      credential: "synthetic-provider",
      model: "synthetic-reasoning",
      providerScope: "synthetic-provider",
      maxInputBytes: 8388608,
      maxOutputTokens: 8192,
      timeoutMs: 120000,
    },
  },
];
let plans = [],
  activeGrant = null,
  dropGrantAck = true,
  grantWrites = 0,
  grantKey = null,
  failPlanRead = false;
let projectionOverride;
const syntheticPresentation = () =>
  projectionOverride !== undefined
    ? projectionOverride
    : !activeGrant
      ? {
          schema: "bailing.usage-presentation.v1",
          kind: "none",
          state: "unavailable",
          remaining: null,
          total: null,
          displayValue: null,
        }
      : {
          schema: "bailing.usage-presentation.v1",
          kind:
            activeGrant.config.mode === "periodic" ? "percentage" : "credits",
          state: activeGrant.state === "active" ? "active" : "suspended",
          remaining: activeGrant.state === "active" ? 99.9 : null,
          total: 100,
          displayValue: activeGrant.state === "active" ? "99" : null,
        };
const summary = () => ({
  presentation: syntheticPresentation(),
  schema: "bailing.token-summary.v1",
  accountId: accounts[0].id,
  grant: activeGrant,
  plan: activeGrant ? (() => { const p=plans.find(p=>p.id===activeGrant.planId); return p ? {id:p.id,label:p.label,revision:p.revision,serviceIds:p.config.serviceIds}:null; })() : null,
  availableTokens: activeGrant ? 999000 : 0,
  consumedTokens: 1000,
  currentPeriodConsumedTokens: 1000,
  overageTokens: 0,
  pendingRequests: 1,
  resetAt:
    activeGrant?.config.mode === "periodic" ? Date.now() + 86400000 : null,
  expiresAt: activeGrant ? Date.now() + 2592000000 : null,
});
await page.route("**/branding", (r) => r.fulfill({ json: {} }));
await page.route("**/health", (r) => r.fulfill({ json: { status: "ok" } }));
await page.route("**/admin/api/**", async (r) => {
  const p = new URL(r.request().url()).pathname,
    method = r.request().method();
  if (method === "POST")
    posts.push({ path: p, body: r.request().postDataJSON() });
  if (p === "/admin/api/me")
    return r.fulfill({
      json: {
        username: "synthetic-admin",
        role: "admin",
        via: "synthetic",
        perms: permissions,
      },
    });
  if (p === "/admin/api/status") return r.fulfill({ json: { executors: [] } });
  if (p === "/admin/api/demo-dataset/status")
    return r.fulfill({ json: { imported: false } });
  if (p === "/admin/api/usage/services") {
    if (method === "GET") return r.fulfill({ json: { items: services } });
    const b = r.request().postDataJSON();
    const original = services.find((item) => item.id === b.id);
    assert.equal(b.expected_revision, original?.revision || 0);
    const saved = {
      id: b.id,
      label: b.label,
      state: b.state,
      revision: (original?.revision || 0) + 1,
      config: b.config,
    };
    if (original) Object.assign(original, saved);
    else services.push(saved);
    return r.fulfill({ json: saved });
  }
  if (p === "/admin/api/usage/accounts")
    return r.fulfill({ json: { items: accounts, next_cursor: null } });
  if (p === "/admin/api/usage/token/plans") {
    if (method === "GET")
      return failPlanRead
        ? r.fulfill({ status: 503, json: { error: "USAGE_TOKEN_UNSUPPORTED" } })
        : r.fulfill({ json: { items: plans } });
    const b = r.request().postDataJSON(),
      old = plans.find((x) => x.id === b.id);
    assert.equal(b.expected_revision, old?.revision || 0);
    const plan = {
      id: b.id,
      label: b.label,
      state: b.state,
      revision: (old?.revision || 0) + 1,
      config: b.config,
    };
    plans = plans.filter((x) => x.id !== b.id).concat(plan);
    return r.fulfill({ json: plan });
  }
  if (p.endsWith("/summary")) return r.fulfill({ json: summary() });
  if (p.endsWith("/requests"))
    return r.fulfill({
      json: {
        items: [
          {
            operation_id: "synthetic-complete",
            service_id: "general",
            result_state: "complete",
            billing_state: "settled",
            charged_tokens: 1000,
            usage: { inputTokens: 800, outputTokens: 200 },
          },
          {
            operation_id: "synthetic-pending-usage",
            service_id: "reasoning",
            result_state: "complete",
            billing_state: "pending",
            charged_tokens: null,
          },
        ],
        next_cursor: null,
      },
    });
  if (p.endsWith("/grant")) {
    const b = r.request().postDataJSON();
    if (!grantKey) {
      grantKey = b.request_key;
      grantWrites++;
      const plan = plans.find((x) => x.id === b.plan_id);
      activeGrant = {
        id: "synthetic-grant",
        label: plan.label,
        planId: plan.id,
        revision: 1,
        state: "active",
        sourceOwner: "hub",
        startsAt: Date.now(),
        config: (({serviceIds,...allowance})=>structuredClone(allowance))(plan.config),
      };
    }
    assert.equal(b.request_key, grantKey);
    assert.equal(b.expected_revision, 0);
    if (dropGrantAck) {
      dropGrantAck = false;
      return r.abort("connectionreset");
    }
    return r.fulfill({ json: activeGrant });
  }
  if (p.endsWith("/control")) {
    const b = r.request().postDataJSON();
    assert.equal(b.expected_revision, activeGrant.revision);
    activeGrant = {
      ...activeGrant,
      state: b.state,
      revision: activeGrant.revision + 1,
    };
    return r.fulfill({ json: activeGrant });
  }
  unexpected.push({ p, method });
  return r.fulfill({
    status: 404,
    json: { error: "UNEXPECTED_SYNTHETIC_ENDPOINT" },
  });
});
try {
  await page.goto(url);
  await page.getByRole("button", { name: "新建套餐", exact: true }).click();
  await page.getByLabel("套餐名称", { exact: true }).fill("联调周享套餐");
  await page
    .locator(".model-choices .el-checkbox")
    .filter({ hasText: "通用模型" })
    .click();
  await page
    .locator(".model-choices .el-checkbox")
    .filter({ hasText: "推理模型" })
    .click();
  const planPreview = page.locator(".preview");
  const creditsMode = page.getByRole("radio", {
    name: "额度包 一次获得固定额度，在有效期内按需使用。",
    exact: true,
  });
  const periodicMode = page.getByRole("radio", {
    name: "周期套餐 订阅期间按日、周或月获得新一期额度。",
    exact: true,
  });
  assert.match(
    await planPreview.locator(".preview-amount").innerText(),
    /100%/,
  );
  assert.doesNotMatch(await planPreview.innerText(), /Token|Credits|相当于/i);
  assert.match(await planPreview.innerText(), /本期剩余额度不累积到下一期/);
  await creditsMode.check();
  assert.match(await planPreview.innerText(), /未用积分在套餐有效期内可用/);
  assert.doesNotMatch(await planPreview.innerText(), /不累积到下一期/);
  assert.match(
    await planPreview.locator(".preview-amount").innerText(),
    /1,000积分/,
  );
  await page.getByLabel("总额度", { exact: true }).fill("0.0101");
  await page.getByLabel("每 1 积分对应的 Token", { exact: true }).fill("100");
  await page.getByLabel("套餐名称", { exact: true }).focus();
  assert.match(
    await planPreview.locator(".preview-amount").innerText(),
    /1.01积分/,
  );
  await page.getByLabel("总额度", { exact: true }).fill("0.0001");
  await page.getByLabel("每 1 积分对应的 Token", { exact: true }).fill("1000");
  await page.getByLabel("套餐名称", { exact: true }).focus();
  assert.match(
    await planPreview.locator(".preview-amount").innerText(),
    /<0.01积分/,
  );
  await periodicMode.check();
  assert.match(
    await planPreview.locator(".preview-amount").innerText(),
    /100%/,
  );
  await page.getByLabel("每期额度", { exact: true }).fill("100");
  await page.getByLabel("套餐名称", { exact: true }).focus();
  assert.equal(
    await page.getByText("用户看到的额度单位", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .locator(".plan-form")
      .getByText(/轮次上限|每轮最多|单轮最长/)
      .count(),
    0,
  );
  await page.locator(".main").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: `${output}/token-plan-desktop.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "保存套餐", exact: true }).click();
  await page.getByRole("button", { name: "新建套餐", exact: true }).waitFor();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].config.quotaTokens, 1000000);
  assert.deepEqual(plans[0].config.serviceIds, ["general", "reasoning"]);
  assert.equal("displayUnit" in plans[0].config, false);
  assert.deepEqual(
    Object.keys(plans[0].config).sort(),
    [
      "mode",
      "serviceIds",
      "quotaTokens",
      "periodUnit",
      "duration",
      "tokensPerCredit",
    ].sort(),
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("套餐名称", { exact: true }).fill("联调周享套餐修订");
  await page.getByRole("button", { name: "保存套餐", exact: true }).click();
  await page.getByRole("button", { name: "新建套餐", exact: true }).waitFor();
  assert.equal(plans[0].revision, 2);
  await page.getByRole("button", { name: "开通给账户", exact: true }).click();
  await page.getByRole("dialog").locator(".el-select").first().click();
  await page.getByRole("option", { name: "合成验收账户", exact: true }).click();
  assert.match(await page.locator(".grant-preview").innerText(), /剩余 100 %/);
  assert.doesNotMatch(
    await page.locator(".grant-preview").innerText(),
    /Token|Credits|相当于/i,
  );
  await page.getByRole("button", { name: "确认开通", exact: true }).click();
  await page
    .getByRole("button", { name: "核对 / 重试原请求", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "核对 / 重试原请求", exact: true })
    .click();
  await page
    .getByText("上一次保存需要核对", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(grantWrites, 1);
  assert.equal(posts.filter((x) => x.path.endsWith("/grant")).length, 2);
  await page.getByRole("tab", { name: "账户用量", exact: true }).click();
  await page.getByRole("button", { name: "查看用量", exact: true }).click();
  await page.getByText("synthetic-complete", { exact: true }).waitFor();
  const detail = page.locator(".account-detail");
  const customerPreview = detail.locator(".customer-preview");
  assert.equal(
    await customerPreview.locator(".preview-amount").innerText(),
    "99%",
  );
  assert.match(await customerPreview.innerText(), /1 笔用量待更新/);
  assert.doesNotMatch(
    await customerPreview.innerText(),
    /Token|Credits|999,000|相当于/i,
  );
  assert.match(
    await detail.locator(".operator-accounting").innerText(),
    /999,000/,
  );
  assert.match(await detail.innerText(), /待计量/);
  assert.match(await detail.innerText(), /输入 800 \/ 输出 200/);
  await detail.getByRole("button", { name: "暂停新请求", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await detail.getByRole("button", { name: "恢复使用", exact: true }).waitFor();
  assert.equal(activeGrant.state, "suspended");
  assert.match(await customerPreview.innerText(), /已暂停/);
  assert.equal(
    await customerPreview.locator(".preview-amount").innerText(),
    "—%",
  );
  await detail.getByRole("button", { name: "恢复使用", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await detail
    .getByRole("button", { name: "暂停新请求", exact: true })
    .waitFor();
  assert.equal(activeGrant.state, "active");
  await page.locator(".el-message-box__wrapper").waitFor({ state: "hidden" });
  await page.locator(".el-message").last().waitFor({ state: "hidden" });
  await page.screenshot({
    path: `${output}/token-account-desktop.png`,
    fullPage: true,
    animations: "disabled",
  });
  const originalGrant = structuredClone(activeGrant);
  const projectionCases = [
    {
      label: "fractional percentage",
      mode: "periodic",
      projection: {
        kind: "percentage",
        state: "active",
        remaining: 0.4,
        total: 100,
        displayValue: "<1",
      },
      amount: "<1%",
      state: "可用",
    },
    {
      label: "zero percentage",
      mode: "periodic",
      projection: {
        kind: "percentage",
        state: "depleted",
        remaining: 0,
        total: 100,
        displayValue: "0",
      },
      amount: "0%",
      state: "额度已用完",
    },
    {
      label: "fractional credits",
      mode: "credits",
      projection: {
        kind: "credits",
        state: "active",
        remaining: 1.019,
        total: 100,
        displayValue: "1.01",
      },
      amount: "1.01积分",
      state: "可用",
    },
    {
      label: "tiny credits",
      mode: "credits",
      projection: {
        kind: "credits",
        state: "active",
        remaining: 0.001,
        total: 100,
        displayValue: "<0.01",
      },
      amount: "<0.01积分",
      state: "可用",
    },
    {
      label: "zero credits",
      mode: "credits",
      projection: {
        kind: "credits",
        state: "depleted",
        remaining: 0,
        total: 100,
        displayValue: "0",
      },
      amount: "0积分",
      state: "额度已用完",
    },
    {
      label: "expired",
      mode: "credits",
      projection: {
        kind: "credits",
        state: "expired",
        remaining: null,
        total: 100,
        displayValue: null,
      },
      amount: "—积分",
      state: "已到期",
    },
    {
      label: "not started",
      mode: "periodic",
      projection: {
        kind: "percentage",
        state: "not_started",
        remaining: null,
        total: 100,
        displayValue: null,
      },
      amount: "—%",
      state: "尚未生效",
    },
    {
      label: "suspended",
      mode: "credits",
      projection: {
        kind: "credits",
        state: "suspended",
        remaining: null,
        total: 100,
        displayValue: null,
      },
      amount: "—积分",
      state: "已暂停",
    },
    {
      label: "missing projection",
      mode: "periodic",
      projection: null,
      amount: "—",
      state: "用量暂不可用",
    },
    {
      label: "unknown projection",
      mode: "periodic",
      projection: {
        schema: "unknown",
        kind: "percentage",
        state: "active",
        remaining: 100,
        total: 100,
        displayValue: "100",
      },
      amount: "—",
      state: "用量暂不可用",
    },
    {
      label: "wrong mode projection",
      mode: "periodic",
      projection: {
        kind: "credits",
        state: "active",
        remaining: 100,
        total: 100,
        displayValue: "100",
      },
      amount: "—",
      state: "用量暂不可用",
    },
    ...["101", "1.25", "<0.01"].map((displayValue) => ({
      label: `invalid percentage ${displayValue}`,
      mode: "periodic",
      projection: {
        kind: "percentage",
        state: "active",
        remaining: 1,
        total: 100,
        displayValue,
      },
      amount: "—",
      state: "用量暂不可用",
    })),
    {
      label: "invalid credits notation",
      mode: "credits",
      projection: {
        kind: "credits",
        state: "active",
        remaining: 0.1,
        total: 100,
        displayValue: "<1",
      },
      amount: "—",
      state: "用量暂不可用",
    },
    {
      label: "credits exceed total",
      mode: "credits",
      projection: {
        kind: "credits",
        state: "active",
        remaining: 101,
        total: 100,
        displayValue: "101",
      },
      amount: "—",
      state: "用量暂不可用",
    },
    {
      label: "not granted",
      mode: null,
      projection: {
        kind: "none",
        state: "unavailable",
        remaining: null,
        total: null,
        displayValue: null,
      },
      amount: "—",
      state: "尚未开通",
    },
  ];
  for (const scenario of projectionCases) {
    activeGrant = scenario.mode
      ? {
          ...structuredClone(originalGrant),
          config: { ...originalGrant.config, mode: scenario.mode },
        }
      : null;
    projectionOverride =
      scenario.projection === null
        ? null
        : { schema: "bailing.usage-presentation.v1", ...scenario.projection };
    await detail.getByRole("button", { name: "刷新用量", exact: true }).click();
    await customerPreview.getByText(scenario.state, { exact: true }).waitFor();
    assert.equal(
      await customerPreview.locator(".preview-amount").innerText(),
      scenario.amount,
      scenario.label,
    );
    assert.doesNotMatch(
      await customerPreview.innerText(),
      /Token|Credits|999,000|相当于/i,
      scenario.label,
    );
    if (scenario.label === "fractional credits")
      await page.screenshot({
        path: `${output}/credits-account-desktop.png`,
        fullPage: true,
        animations: "disabled",
      });
  }
  activeGrant = originalGrant;
  projectionOverride = undefined;
  await page.locator(".el-drawer__close-btn").click();
  await page.getByRole("tab", { name: "套餐管理", exact: true }).click();
  await page.getByRole("button", { name: "新建套餐", exact: true }).click();
  await page.getByLabel("套餐名称", { exact: true }).fill("一次性额度包");
  await page
    .getByRole("radio", {
      name: "额度包 一次获得固定额度，在有效期内按需使用。",
      exact: true,
    })
    .check();
  await page
    .locator(".model-choices .el-checkbox")
    .filter({ hasText: "通用模型" })
    .click();
  await page.locator(".preview").screenshot({
    path: `${output}/credits-plan-preview.png`,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".main").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: `${output}/token-plan-mobile.png`,
    fullPage: true,
    animations: "disabled",
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(overflow, false, "mobile should not overflow");
  await page.getByRole("button", { name: "保存套餐", exact: true }).click();
  await page.getByRole("button", { name: "新建套餐", exact: true }).waitFor();
  assert.equal(plans[1].config.mode, "credits");
  assert.ok(!("periodUnit" in plans[1].config));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("tab", { name: "模型服务", exact: true }).click();
  await page.getByRole("button", { name: "添加模型服务", exact: true }).click();
  const serviceDialog = page.getByRole("dialog");
  await serviceDialog
    .getByLabel("显示名称", { exact: true })
    .fill("附加合成模型");
  await serviceDialog
    .getByLabel("服务标识", { exact: true })
    .fill("extra-synthetic");
  await serviceDialog
    .getByLabel("模型凭证名称", { exact: true })
    .fill("existing-synthetic-credential");
  await serviceDialog
    .getByLabel("模型标识", { exact: true })
    .fill("synthetic-extra");
  await page.getByRole("button", { name: "保存服务", exact: true }).click();
  await serviceDialog.waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "附加合成模型", exact: true })
    .waitFor();
  const savedService = services.find((s) => s.id === "extra-synthetic");
  assert.equal(savedService.config.credential, "existing-synthetic-credential");
  assert.deepEqual(
    Object.keys(savedService.config).sort(),
    [
      "credential",
      "model",
      "providerScope",
      "maxOutputTokens",
      "maxInputBytes",
      "timeoutMs",
    ].sort(),
  );
  assert.equal("api_key" in savedService.config, false);
  failPlanRead = true;
  await page.reload();
  await page
    .getByText("用量套餐尚未就绪，请核对迁移。", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "套餐管理", exact: true })
      .getAttribute("class")
      .then((value) => value.includes("is-disabled")),
    true,
  );
  failPlanRead = false;
  permissions = ["usage:read"];
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload();
  await page.getByRole("tab", { name: "账户用量", exact: true }).waitFor();
  await page.getByText("联调周享套餐修订", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "新建套餐", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "开通给账户", exact: true }).count(),
    0,
  );
  await page.getByRole("tab", { name: "模型服务", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "添加模型服务", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "接入设置", exact: true })
      .getAttribute("href"),
    "/console/usage-access",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "mode-controlled credits/percentage previews without Token",
          "mode switch immediately updates full-period percentage",
          "fractional and tiny credit previews use integer-safe floor",
          "old display-unit pending payload cleared without replay",
          "seventeen account projection, malformed projection and state cases",
          "account preview never falls back to raw Token",
          "pending usage preserves actual remaining balance",
          "multi-model shared quota",
          "revisioned edit",
          "lost grant ACK then reload exact-key recovery",
          "no duplicate allocation",
          "actual usage and pending usage",
          "pause/resume revision",
          "allowance pack no period",
          "responsive mobile",
          "unsupported visible",
          "existing model credential reference only",
          "read-only administrator no mutation actions",
        ],
        requests: posts.map((x) => ({
          path: x.path,
          revision: x.body.expected_revision,
        })),
        screenshots: output,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(
    JSON.stringify(
      {
        posts,
        errors,
        unexpected,
        body: await page
          .locator("body")
          .innerText({ timeout: 1000 })
          .catch(() => "unavailable"),
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
