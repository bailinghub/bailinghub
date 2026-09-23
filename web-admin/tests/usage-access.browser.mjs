import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const origin = process.env.TOKEN_CONSOLE_ORIGIN || "http://127.0.0.1:4438";
const output =
  process.env.TOKEN_CONSOLE_EVIDENCE || "/tmp/bailing-token-only-console";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
await context.addInitScript(() =>
  sessionStorage.setItem(
    "bailing:usage:pending:v1::synthetic-admin",
    JSON.stringify({
      path: "/admin/api/usage/plans",
      method: "POST",
      body: { id: "retired-must-not-replay" },
    }),
  ),
);
const page = await context.newPage(),
  errors = [],
  unexpected = [],
  writes = [];
page.setDefaultTimeout(10000);
page.on("pageerror", (e) => errors.push(e.message));
let permissions = ["*"],
  issuers = [],
  lostAccountAck = true,
  lostRotateAck = true,
  accountWrites = 0,
  rotationWrites = 0,
  accountKey = null;
const accounts = [
  {
    id: "personal-synthetic",
    label: "合成个人账户",
    kind: "personal",
    state: "active",
    revision: 1,
    createdAt: Date.now(),
  },
];
const members = new Map([
  [
    "personal-synthetic",
    [{ userId: "user-synthetic-1", state: "active", revision: 1 }],
  ],
]);
const services = [
  { id: "model-synthetic", label: "合成模型服务", state: "active" },
];
await page.route("**/branding", (r) => r.fulfill({ json: {} }));
await page.route("**/health", (r) => r.fulfill({ json: { status: "ok" } }));
await page.route("**/admin/api/**", async (r) => {
  const p = new URL(r.request().url()).pathname,
    m = r.request().method(),
    b = ["POST", "PUT"].includes(m) ? r.request().postDataJSON() : null;
  if (b) writes.push({ path: p, method: m, body: b });
  if (p === "/admin/api/me")
    return r.fulfill({
      json: { username: "synthetic-admin", role: "admin", perms: permissions },
    });
  if (p === "/admin/api/status") return r.fulfill({ json: { executors: [] } });
  if (p === "/admin/api/demo-dataset/status")
    return r.fulfill({ json: { imported: false } });
  if (p === "/admin/api/usage/services")
    return r.fulfill({ json: { items: services } });
  if (p === "/admin/api/usage/issuers") {
    if (m === "GET") return r.fulfill({ json: { items: issuers } });
    assert.deepEqual(b.permissions, [
      "identity:exchange",
      "identity:revoke",
      "entitlements:write",
      "allowance:grant",
    ]);
    const issuer = {
      id: b.id,
      label: b.label,
      revision: 1,
      state: "active",
      serviceIds: b.service_ids,
      accountIds: b.account_ids,
      permissions: b.permissions,
    };
    issuers.push(issuer);
    return r.fulfill({
      json: { issuer, credential: "synthetic-secret-not-real", created: true },
    });
  }
  if (p === "/admin/api/usage/accounts") {
    if (m === "GET")
      return r.fulfill({ json: { items: accounts, next_cursor: null } });
    if (!accountKey) {
      accountKey = b.request_key;
      accountWrites++;
      accounts.push({
        id: "organization-synthetic",
        label: b.label,
        kind: b.kind,
        state: "active",
        revision: 1,
        createdAt: Date.now(),
      });
      members.set("organization-synthetic", [
        { userId: b.user_id, state: "active", revision: 1 },
      ]);
    }
    assert.equal(b.request_key, accountKey);
    assert.equal(b.source_id, accountKey);
    assert.equal(b.kind, "organization");
    if (lostAccountAck) {
      lostAccountAck = false;
      return r.abort("connectionreset");
    }
    return r.fulfill({ json: accounts.at(-1) });
  }
  const account = p.match(/^\/admin\/api\/usage\/accounts\/([^/]+)$/);
  if (account && m === "GET")
    return r.fulfill({
      json: {
        account: accounts.find((a) => a.id === account[1]),
        members: members.get(account[1]) || [],
      },
    });
  const member = p.match(
    /^\/admin\/api\/usage\/accounts\/([^/]+)\/members\/([^/]+)$/,
  );
  if (member && m === "PUT") {
    const list = members.get(member[1]),
      old = list.find((x) => x.userId === member[2]);
    assert.equal(b.expected_revision, old?.revision || 0);
    const value = {
      userId: member[2],
      state: b.state,
      revision: (old?.revision || 0) + 1,
    };
    if (old) Object.assign(old, value);
    else list.push(value);
    return r.fulfill({ json: value });
  }
  const accountControl = p.match(
    /^\/admin\/api\/usage\/accounts\/([^/]+)\/control$/,
  );
  if (accountControl && m === "POST") {
    const a = accounts.find((x) => x.id === accountControl[1]);
    assert.equal(b.expected_revision, a.revision);
    a.state = b.state;
    a.revision++;
    return r.fulfill({ json: a });
  }
  const issuerControl = p.match(
    /^\/admin\/api\/usage\/issuers\/([^/]+)\/control$/,
  );
  if (issuerControl && m === "POST") {
    const issuer = issuers.find((x) => x.id === issuerControl[1]);
    if (b.expected_revision !== issuer.revision)
      return r.fulfill({
        status: 409,
        json: { error: "USAGE_REVISION_CONFLICT" },
      });
    issuer.revision++;
    issuer.state = b.state;
    if (b.rotate) {
      rotationWrites++;
      if (lostRotateAck) {
        lostRotateAck = false;
        return r.abort("connectionreset");
      }
    }
    return r.fulfill({
      json: {
        issuer,
        credential: b.rotate ? "synthetic-rotated-secret-not-real" : null,
      },
    });
  }
  unexpected.push({ p, m });
  return r.fulfill({ status: 404, json: { error: "UNEXPECTED_ENDPOINT" } });
});
try {
  await page.goto(`${origin}/console/usage-access`);
  await page.getByRole("button", { name: "新增身份来源", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("来源名称", { exact: true }).fill("合成商城登录");
  await dialog.getByLabel("稳定标识", { exact: true }).fill("synthetic:login");
  await dialog
    .locator(".el-form-item")
    .filter({ hasText: "允许的模型服务" })
    .locator(".el-select")
    .click();
  await page.getByRole("option", { name: "合成模型服务", exact: true }).click();
  await page.keyboard.press("Escape");
  await dialog
    .locator(".el-checkbox")
    .filter({ hasText: "管理套餐状态" })
    .click();
  await dialog
    .locator(".el-checkbox")
    .filter({ hasText: "开通 Token 额度" })
    .click();
  await dialog
    .getByRole("button", { name: "创建身份来源", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "保存服务端来源凭证", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("dialog", { name: "保存服务端来源凭证", exact: true })
      .locator("input")
      .getAttribute("type"),
    "password",
  );
  await page.getByRole("button", { name: "已安全保存", exact: true }).click();
  await page
    .getByRole("dialog", { name: "保存服务端来源凭证", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(issuers.length, 1);
  assert.equal(
    await page.evaluate(() =>
      Object.values(sessionStorage).some((value) =>
        value.includes("synthetic-secret-not-real"),
      ),
    ),
    false,
  );
  await page.locator(".main").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: `${output}/access-issuers.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "账户与成员", exact: true }).click();
  await page.getByRole("button", { name: "创建共享账户", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("共享账户名称", { exact: true }).fill("合成运营团队");
  await dialog
    .getByLabel("首位成员的 AI 使用人标识", { exact: true })
    .fill("user-synthetic-1");
  await dialog
    .getByRole("button", { name: "创建共享账户", exact: true })
    .click();
  await page
    .getByRole("button", { name: "核对 / 重试原配置", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "核对 / 重试原配置", exact: true })
    .click();
  await page
    .getByText("有一项配置需要核对原结果", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(accountWrites, 1);
  await page.getByRole("tab", { name: "账户与成员", exact: true }).click();
  await page.getByRole("button", { name: "合成运营团队", exact: true }).click();
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "添加账户成员", exact: true });
  await dialog
    .getByLabel("成员的 AI 使用人标识", { exact: true })
    .fill("user-synthetic-2");
  await dialog.getByRole("button", { name: "添加成员", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const row = page
    .locator(".el-drawer .el-table__row")
    .filter({ hasText: "user-synthetic-2" });
  await row.getByRole("button", { name: "移除成员", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await row.getByRole("button", { name: "恢复成员", exact: true }).waitFor();
  assert.equal(members.get("organization-synthetic")[1].state, "revoked");
  await row.getByRole("button", { name: "恢复成员", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await row.getByRole("button", { name: "移除成员", exact: true }).waitFor();
  await page.getByRole("button", { name: "停用账户", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "恢复账户", exact: true }).waitFor();
  assert.equal(accounts[1].state, "suspended");
  await page.getByRole("button", { name: "恢复账户", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "停用账户", exact: true }).waitFor();
  await page.locator(".el-message-box__wrapper").waitFor({ state: "hidden" });
  await page.locator(".el-message").last().waitFor({ state: "hidden" });
  await page.screenshot({
    path: `${output}/access-members.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.locator(".el-drawer__close-btn").click();
  await page.getByRole("tab", { name: "身份来源", exact: true }).click();
  await page.getByRole("button", { name: "停用来源", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "恢复来源", exact: true }).waitFor();
  await page.getByRole("button", { name: "恢复来源", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "停用来源", exact: true }).waitFor();
  await page.getByRole("button", { name: "轮换凭证", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page
    .getByRole("button", { name: "核对 / 重试原配置", exact: true })
    .click();
  await page
    .getByText(
      "来源修订已变化，无法恢复上次生成的凭证。已刷新当前来源，请重新轮换并安全保存新凭证。",
      { exact: true },
    )
    .first()
    .waitFor();
  assert.equal(rotationWrites, 1);
  assert.equal(
    await page
      .getByRole("dialog", { name: "保存服务端来源凭证", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "轮换凭证", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page
    .getByRole("dialog", { name: "保存服务端来源凭证", exact: true })
    .waitFor();
  assert.equal(rotationWrites, 2);
  await page.getByRole("button", { name: "已安全保存", exact: true }).click();
  permissions = ["usage:read"];
  await page.reload();
  await page
    .getByText("当前管理员可以查看用量，但没有身份来源管理权限。", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "新增身份来源", exact: true })
      .count(),
    0,
  );
  await page.getByRole("tab", { name: "账户与成员", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "创建共享账户", exact: true })
      .count(),
    0,
  );
  await page.evaluate(() => {
    history.pushState({}, "", "/console/usage/legacy");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.locator(".usage-access").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".usage-access,.usage-page,.token-page").count(),
    0,
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "identity source explicit model scope and allowance permission",
          "source credential masked and never persisted",
          "organization account lost ACK exact-key recovery",
          "member add/remove/restore revision",
          "account pause/resume revision",
          "issuer pause/resume",
          "lost rotation response does not rotate twice",
          "explicit fresh rotation after conflict",
          "read-only no mutation controls",
          "retired local request never replayed",
          "removed route has no component",
        ],
        writePaths: writes.map((x) => ({ path: x.path, method: x.method })),
        accountWrites,
        rotationWrites,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(
    JSON.stringify(
      {
        errors,
        unexpected,
        body: await page
          .locator("body")
          .innerText({ timeout: 1000 })
          .catch(() => ""),
        writes: writes.map((x) => ({ path: x.path, method: x.method })),
      },
      null,
      2,
    ),
  );
  throw e;
} finally {
  await browser.close();
}
