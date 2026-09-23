<template>
  <el-card class="usage-access" shadow="never">
    <template #header>
      <div class="heading">
        <div class="page-title">
          <b>接入设置</b>
          <UsageHelp title="接入设置说明">
            <template v-if="tab === 'issuers'">
              <p><b>身份来源：</b>业务产品负责登录，中枢按可信使用人管理模型额度。例如企业统一登录服务或独立 AI 助手后端。</p>
              <p>创建来源时选择允许的模型服务；产品校验登录后，以稳定主体标识交换短期使用凭证。来源凭证仅交给可信服务端，不放入客户端或模型上下文。</p>
              <p>闲置来源可以删除；已有登录身份或用量关联时请停用，删除前会显示占用原因。</p>
              <p>登录会自动建立个人账户；团队共享额度时，再创建组织账户并添加成员。</p>
            </template>
            <template v-else>
              <p><b>账户与成员：</b>登录会自动建立个人账户。组织账户需明确添加成员，再从套餐页开通共用额度。</p>
              <p>个人和共享账户停用后均可移除，历史不受影响。在“已移除”中可恢复原账户，恢复后仍停用，不补发额度；原使用凭证不恢复。组织成员在账户详情中管理。</p>
              <p>这里管理共享账户与成员；业务授权与审批仍由原系统负责，共享用量账户不会额外授予业务权限。</p>
            </template>
          </UsageHelp>
        </div>
        <div class="actions">
          <router-link to="/usage"
            ><el-button>返回模型与套餐</el-button></router-link
          ><el-button :loading="loading" @click="load">刷新设置</el-button>
        </div>
      </div>
    </template>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <section v-if="pending" class="panel pending">
      <b>有一项配置需要核对原结果</b>
      <p>
        已保留原提交内容。重试继续使用原请求，不会新建另一份账户或重复变更成员。
      </p>
      <el-button type="primary" :loading="saving" @click="retryPending"
        >核对 / 重试原配置</el-button
      >
    </section>
    <div class="console-page-tabs">
      <div class="console-page-tabs-actions">
        <el-button v-if="tab === 'issuers' && canManageIssuers" type="primary" :disabled="blocked" @click="openForm('issuer')">新增身份来源</el-button>
        <template v-else-if="tab === 'accounts'">
          <el-select v-model="accountView" aria-label="账户视图" style="width: 140px" :disabled="accountsLoading || blocked" @change="changeAccountView">
            <el-option label="账户列表" value="current" /><el-option label="已移除" value="archived" />
          </el-select>
          <el-button v-if="canWrite && accountView === 'current'" type="primary" :disabled="blocked" @click="openForm('account')">创建共享账户</el-button>
        </template>
      </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="身份来源" name="issuers">
        <el-alert
          v-if="!canViewIssuers"
          title="当前管理员可以查看用量，但没有身份来源管理权限。"
          type="info"
          :closable="false"
        />
        <el-table v-else :data="issuers" row-key="id"
          ><el-table-column label="身份来源" min-width="200"
            ><template #default="{ row }"
              ><b>{{ row.label }}</b>
              <div class="muted mono">{{ row.id }}</div></template
            ></el-table-column
          ><el-table-column label="允许的模型服务" min-width="160"
            ><template #default="{ row }"
              ><div v-for="id in row.serviceIds" :key="id">
                {{ serviceLabel(id) }}
              </div></template
            ></el-table-column
          ><el-table-column label="服务端权限" min-width="180"
            ><template #default="{ row }"
              ><div v-for="permission in row.permissions" :key="permission">
                {{ permissionLabel(permission) }}
              </div></template
            ></el-table-column
          ><el-table-column label="状态" width="100"
            ><template #default="{ row }"
              ><el-tag :type="row.state === 'active' ? 'success' : 'info'">{{
                row.state === "active" ? "启用" : "停用"
              }}</el-tag></template
            ></el-table-column
          ><el-table-column v-if="canManageIssuers" label="操作" width="250" align="right" fixed="right"
            ><template #default="{ row }"
              ><el-button
                link
                :disabled="blocked"
                @click="controlIssuer(row, false)"
                >{{
                  row.state === "active" ? "停用来源" : "恢复来源"
                }}</el-button
              ><el-button
                link
                type="primary"
                :disabled="blocked"
                @click="controlIssuer(row, true)"
                >轮换凭证</el-button
              ><el-button link type="danger" :disabled="blocked" @click="deleteResource('issuer', row)">删除</el-button></template
            ></el-table-column
          ><template #empty
            >还没有可信身份来源。新增后将专用凭证交给业务登录后端配置。</template
          ></el-table
        >
      </el-tab-pane>
      <el-tab-pane label="账户与成员" name="accounts">
        <el-table :data="accounts" row-key="id"
          ><el-table-column label="账户" min-width="220"
            ><template #default="{ row }"
              ><el-button link type="primary" @click="openAccount(row)">{{
                row.label
              }}</el-button>
              <div class="muted mono">{{ row.id }}</div></template
            ></el-table-column
          ><el-table-column label="类型" width="140"
            ><template #default="{ row }">{{
              row.kind === "organization" ? "组织共享" : "个人"
            }}</template></el-table-column
          ><el-table-column label="状态" width="120"
            ><template #default="{ row }"
              ><el-tag :type="row.state === 'active' ? 'success' : 'info'">{{
                row.state === "archived" ? "已移除" : row.state === "active" ? "可用" : "停用"
              }}</el-tag></template
            ></el-table-column
          ><el-table-column label="创建时间" min-width="175"
            ><template #default="{ row }">{{
              time(row.createdAt)
            }}</template></el-table-column
          ><el-table-column label="操作" width="195" align="right" fixed="right"
            ><template #default="{ row }"
              ><el-button link type="primary" @click="openAccount(row)"
                >账户与成员</el-button
              ><el-button v-if="canWrite && row.state === 'archived'" link type="primary" :disabled="blocked" @click="restoreAccount(row)">恢复</el-button><el-button v-else-if="canWrite" link type="danger" :disabled="blocked" @click="deleteResource('account', row)">移除</el-button></template
            ></el-table-column
          ><template #empty
            >{{ accountView === "archived" ? "暂无已移除账户。" : "还没有用量账户。请先让产品通过可信身份来源完成一次登录。" }}</template
          ></el-table
        >
        <div v-if="cursor" class="more">
          <el-button :loading="accountsLoading" @click="loadMoreAccounts"
            >加载更多账户</el-button
          >
        </div>
      </el-tab-pane>
    </el-tabs>
    </div>
  </el-card>

    <UsageDeletionPreview v-model="deletion.open.value" :label="deletion.label.value"
      :report="deletion.report.value" :loading="deletion.loading.value" :busy="blocked"
      :error="deletion.error.value" @refresh="deletion.refresh" @delete="confirmDeleteResource" />
    <el-drawer
      v-model="detailOpen"
      :title="selected?.label || '账户与成员'"
      size="min(780px,96vw)"
      @closed="openDeferredForm"
      ><div class="detail" v-loading="detailLoading">
        <el-alert
          v-if="detailError"
          :title="detailError"
          type="error"
          :closable="false"
        /><template v-if="selected"
          ><div class="section-heading">
            <div>
              <p class="mono muted">{{ selected.id }}</p>
              <p>
                {{
                  selected.kind === "organization" ? "组织共享账户" : "个人账户"
                }}
                · {{ selected.state === "archived" ? "已移除" : selected.state === "active" ? "可用" : "已停用" }}
              </p>
            </div>
            <el-button
              v-if="canWrite && selected.state !== 'archived'"
              :disabled="blocked"
              @click="controlAccount"
              >{{
                selected.state === "active" ? "停用账户" : "启用账户"
              }}</el-button
            >
            <el-button v-if="canWrite && selected.state === 'archived'" :disabled="blocked" @click="restoreAccount(selected)">恢复至账户列表</el-button>
          </div>
          <p class="muted">
            停用账户会停止新的模型请求，已发生的用量仍保留原归属。账户成员资格不授予任何业务系统权限。
          </p>
          <div class="section-heading">
            <h3>账户成员</h3>
            <el-button
              v-if="canWrite && selected.state !== 'archived' && selected.kind === 'organization'"
              :disabled="blocked"
              @click="openForm('member')"
              >添加成员</el-button
            >
          </div>
          <el-table :data="members" row-key="userId"
            ><el-table-column
              prop="userId"
              label="AI 使用人标识"
              min-width="260"
            /><el-table-column label="资格" width="110"
              ><template #default="{ row }">{{
                row.state === "active" ? "有效" : "已移除"
              }}</template></el-table-column
            ><el-table-column
              v-if="canWrite && selected.state !== 'archived' && selected.kind === 'organization'"
              width="100"
              ><template #default="{ row }"
                ><el-button
                  link
                  :disabled="blocked"
                  @click="controlMember(row)"
                  >{{
                    row.state === "active" ? "移除成员" : "恢复成员"
                  }}</el-button
                ></template
              ></el-table-column
            ></el-table
          >
          <p v-if="members.length >= 500" class="muted">
            当前显示前 500 位成员。
          </p></template
        >
      </div></el-drawer
    >

    <el-drawer
      v-model="formOpen"
      :title="formTitle"
      size="min(540px,100vw)"
      class="access-config-drawer"
      @closed="finishFormClose"
      :close-on-click-modal="false"
      ><el-form
        novalidate
        label-position="top"
        :disabled="blocked"
        @submit.prevent="submit"
      >
        <template v-if="formKind === 'issuer'"
          ><div class="form-grid">
            <el-form-item label="来源名称"
              ><el-input
                v-model="form.label"
                placeholder="例如：企业统一登录服务"
                maxlength="120" /></el-form-item
            ><el-form-item label="稳定标识"
              ><el-input
                v-model="form.id"
                placeholder="例如 commerce-login"
                maxlength="64"
            /></el-form-item>
          </div>
          <el-form-item label="允许的模型服务"
            ><el-select
              v-model="form.serviceIds"
              multiple
              placeholder="选择该来源允许使用的服务"
              ><el-option
                v-for="service in services"
                :key="service.id"
                :value="service.id"
                :label="service.label"
                :disabled="
                  service.state !== 'active'
                " /></el-select></el-form-item
          ><el-form-item label="服务端权限"
            ><el-checkbox-group v-model="form.permissions" class="permissions"
              ><el-checkbox
                v-for="permission in permissions"
                :key="permission.value"
                :value="permission.value"
                ><span
                  >{{ permission.label
                  }}<small>{{ permission.description }}</small></span
                ></el-checkbox
              ></el-checkbox-group
            ></el-form-item
          ><el-form-item
            ><template #label
              >允许访问的组织账户（可选）
              <UsageHelp title="来源的账户范围"
                ><p>
                  来源只能管理自己的个人账户，或明确选中的组织账户；不会自动获得全部模型与账户。
                </p>
                <p>
                  组织账户白名单不代替成员资格，使用人仍需是有效成员。
                </p></UsageHelp
              ></template
            ><el-select
              v-model="form.accountIds"
              multiple
              filterable
              placeholder="仅在需要共享账户时选择"
              ><el-option
                v-for="account in accounts.filter(
                  (a) => a.kind === 'organization',
                )"
                :key="account.id"
                :value="account.id"
                :label="account.label"
                :disabled="account.state !== 'active'" /></el-select
            ><el-button
              v-if="cursor"
              link
              :loading="accountsLoading"
              @click="loadMoreAccounts"
              >加载更多账户</el-button
            ></el-form-item
          >
        </template>
        <template v-else-if="formKind === 'account'"
          ><el-form-item label="共享账户名称"
            ><el-input
              v-model="form.label"
              placeholder="例如：产品运营团队"
              maxlength="120" /></el-form-item
          ><el-form-item
            ><template #label
              >首位成员的 AI 使用人标识
              <UsageHelp title="从哪里取得使用人标识"
                ><p>
                  填写可信登录交换结果中的 user_id。首位成员需已通过产品登录建立
                  AI 使用身份，不填写手机号、组织名称或业务系统本地编号。
                </p>
                <p>创建后再为共享账户开通套餐。</p></UsageHelp
              ></template
            ><el-input
              v-model="form.userId"
              placeholder="从可信登录交换结果取得的 user_id"
          /></el-form-item>
        </template>
        <template v-else
          ><el-form-item
            ><template #label
              >成员的 AI 使用人标识
              <UsageHelp title="添加共享账户成员"
                ><p>使用可信登录交换结果中的 user_id，成员仍使用原身份。</p>
                <p>
                  加入后共用当前组织账户的模型额度，不改变业务授权范围。
                </p></UsageHelp
              ></template
            ><el-input
              v-model="form.userId"
              placeholder="可信登录交换结果中的 user_id"
          /></el-form-item>
          <p class="muted">
            加入后即可共用“{{ selected?.label }}”的已开通额度。
          </p></template
        >
        <el-alert
          v-if="formError"
          :title="formError"
          type="error"
          :closable="false"
        />
      </el-form>
      <template #footer
        ><div class="drawer-actions">
          <el-button @click="formOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="
              blocked || (formKind === 'issuer' ? !canManageIssuers : !canWrite)
            "
            @click="submit"
            >{{
              formKind === "issuer"
                ? "创建身份来源"
                : formKind === "account"
                  ? "创建共享账户"
                  : "添加成员"
            }}</el-button
          >
        </div></template
      >
    </el-drawer>
    <el-drawer
      v-model="credentialOpen"
      title="保存服务端来源凭证"
      size="min(520px,100vw)"
      class="access-config-drawer"
      :close-on-click-modal="false"
      @closed="credential = ''"
    >
      <el-alert
        title="凭证仅显示这一次。请保存到产品后端的安全配置中，不放入浏览器、智能体提示词或公开文档。"
        type="warning"
        :closable="false"
      /><el-input
        class="credential"
        :model-value="credential"
        type="password"
        readonly
        show-password
        autocomplete="off"
      /><template #footer
        ><div class="drawer-actions">
          <el-button @click="copyCredential">复制凭证</el-button
          ><el-button type="primary" @click="credentialOpen = false"
            >已安全保存</el-button
          >
        </div></template
      >
    </el-drawer>
</template>
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { ElCheckboxGroup } from "element-plus/es/components/checkbox/index";
import { ElMessage } from "element-plus/es/components/message/index";
import { ElMessageBox } from "element-plus/es/components/message-box/index";
import { api } from "../request";
import { useMe } from "../store";
import { kernelMountPath } from "../runtime-path";
import UsageDeletionPreview from "../components/UsageDeletionPreview.vue";
import { useUsageDeletion } from "../usage-deletion";
import UsageHelp from "../components/UsageHelp.vue";
interface Account {
  id: string;
  label: string;
  kind: "personal" | "organization";
  state: "active" | "suspended" | "archived";
  revision: number;
  createdAt: number;
}
interface Member {
  userId: string;
  state: "active" | "revoked";
  revision: number;
}
interface Service {
  id: string;
  label: string;
  state: "active" | "suspended";
}
interface Issuer {
  id: string;
  label: string;
  revision: number;
  state: "active" | "suspended";
  serviceIds: string[];
  permissions: string[];
  accountIds: string[];
}
type FormKind = "issuer" | "account" | "member";
interface Attempt {
  path: string;
  method: "POST" | "PUT" | "DELETE";
  body: Record<string, unknown>;
  kind: FormKind | "issuer_control" | "account_control" | "member_control" | "issuer_delete" | "account_delete" | "account_restore";
}
const base = "/admin/api/usage",
  me = useMe(),
  route = useRoute();
const canWrite = computed(() => me.can("usage:write")),
  canViewIssuers = computed(() => me.can("usage:issuers")),
  canManageIssuers = computed(() => canWrite.value && canViewIssuers.value);
const tab = ref(route.query.tab === "accounts" ? "accounts" : "issuers"),
  loading = ref(false),
  saving = ref(false),
  error = ref(""),
  pending = ref<Attempt | null>(null),
  storageFailed = ref(false);
const blocked = computed(
  () => loading.value || saving.value || !!pending.value || storageFailed.value,
);
const accountView = ref<"current" | "archived">("current");
const accounts = ref<Account[]>([]),
  issuers = ref<Issuer[]>([]),
  services = ref<Service[]>([]),
  cursor = ref<string | null>(null),
  accountsLoading = ref(false);
const selected = ref<Account | null>(null),
  members = ref<Member[]>([]),
  detailOpen = ref(false),
  detailLoading = ref(false),
  detailError = ref("");
const formFromAccount = ref(false),
  deferredForm = ref(false),
  deferredCredential = ref(false);
const formOpen = ref(false),
  formKind = ref<FormKind>("issuer"),
  formError = ref("");
const defaults = () => ({
  id: "",
  label: "",
  userId: "",
  serviceIds: [] as string[],
  accountIds: [] as string[],
  permissions: ["identity:exchange", "identity:revoke"] as string[],
});
const form = reactive(defaults());
const formTitle = computed(
  () =>
    ({
      issuer: "新增身份来源",
      account: "创建共享账户",
      member: "添加账户成员",
    })[formKind.value],
);
const credentialOpen = ref(false),
  credential = ref("");
const permissions = [
  {
    value: "identity:exchange",
    label: "交换登录身份",
    description: "为已经登录的用户取得短期模型使用凭证。",
  },
  {
    value: "identity:revoke",
    label: "撤销使用身份",
    description: "产品账号停用时，让对应的模型使用身份失效。",
  },
  {
    value: "entitlements:write",
    label: "管理套餐状态",
    description: "允许产品后端开通套餐、暂停或恢复使用。",
  },
  {
    value: "allowance:grant",
    label: "开通用量额度",
    description: "配合套餐管理权限，按选定套餐发放一份额度。",
  },
  {
    value: "usage:read",
    label: "读取用量",
    description: "读取本来源有权访问的账户用量与套餐目录。",
  },
];
const permissionLabel = (key: string) =>
  permissions.find((p) => p.value === key)?.label || key;
const segment = (id: string) => encodeURIComponent(id).replaceAll("%3A", ":");
const serviceLabel = (id: string) =>
  services.value.find((s) => s.id === id)?.label || id;
const time = (n: number) =>
  new Date(n).toLocaleString("zh-CN", { hour12: false });
function message(e: unknown) {
  const code = e instanceof Error ? e.message : "请求失败";
  const known: Record<string, string> = {
    USAGE_RESOURCE_IN_USE: "该记录已有使用关联，请查看删除抽屉中的占用原因。",
    USAGE_RESOURCE_DELETED: "记录已删除，原标识不能重新使用。",
    USAGE_RESOURCE_NOT_FOUND: "记录已不存在，请刷新列表。",
    USAGE_FORBIDDEN: "当前管理员没有此操作权限。",
    USAGE_REVISION_CONFLICT: "记录已更新，请刷新并核对当前状态。",
    USAGE_USER_NOT_FOUND: "该 AI 使用身份不存在，请先让成员通过可信产品登录。",
    USAGE_ACCOUNT_FORBIDDEN: "所选账户不可用或已删除，请刷新并核对来源的账户范围。",
    USAGE_ACCOUNT_SUSPENDED: "账户已停用或移除，请先在账户列表核对并恢复原账户。",
    USAGE_ACCOUNT_NOT_FOUND: "账户已不存在，请刷新。",
    USAGE_NOT_FOUND: "记录已不存在，请刷新。",
    USAGE_INVALID_INPUT: "配置不符合要求，请检查填写内容。",
    USAGE_IDEMPOTENCY_CONFLICT: "原请求内容发生冲突，请核对原操作。",
    USAGE_UNSUPPORTED: "用量模块尚未就绪，请核对版本与迁移。",
  };
  return known[code] || `操作未完成：${code}`;
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  if (!storageFailed.value) error.value = "";
  try {
    const results = await Promise.allSettled([
      loadAccounts(),
      api<{ items: Service[] }>(`${base}/services`).then(
        (r) => (services.value = r.items),
      ),
      canViewIssuers.value
        ? api<{ items: Issuer[] }>(`${base}/issuers`).then(
            (r) => (issuers.value = r.items),
          )
        : Promise.resolve(),
    ]);
    for (const r of results) if (r.status === "rejected") throw r.reason;
  } catch (e) {
    error.value = message(e);
  } finally {
    loading.value = false;
  }
}
async function loadAccounts(more = false) {
  if (accountsLoading.value) return;
  accountsLoading.value = true;
  try {
    const query = new URLSearchParams({ limit: "30", view: accountView.value });
    if (more && cursor.value) query.set("cursor", cursor.value);
    const r = await api<{ items: Account[]; next_cursor: string | null }>(
      `${base}/accounts?${query}`,
    );
    accounts.value = more ? [...accounts.value, ...r.items] : r.items;
    cursor.value = r.next_cursor;
  } finally {
    accountsLoading.value = false;
  }
}
async function changeAccountView() {
  accounts.value = []; cursor.value = null;
  try { await loadAccounts(); } catch (e) { error.value = message(e); }
}
async function loadMoreAccounts() {
  try {
    await loadAccounts(true);
  } catch (e) {
    error.value = message(e);
  }
}
async function openAccount(account: Account) {
  selected.value = account;
  detailOpen.value = true;
  await loadDetail();
}
async function loadDetail() {
  const id = selected.value?.id;
  if (!id) return;
  detailLoading.value = true;
  detailError.value = "";
  members.value = [];
  try {
    const result = await api<{ account: Account | null; members: Member[] }>(
      `${base}/accounts/${segment(id)}`,
    );
    if (selected.value?.id !== id) return;
    if (!result.account) throw new Error("USAGE_ACCOUNT_NOT_FOUND");
    selected.value = result.account;
    members.value = result.members;
  } catch (e) {
    detailError.value = message(e);
  } finally {
    detailLoading.value = false;
  }
}
async function openForm(kind: FormKind) {
  if (kind === 'issuer' && accountView.value !== 'current') {
    accountView.value = 'current';
    try { await changeAccountView(); } catch { return; }
  }
  formKind.value = kind;
  Object.assign(form, defaults());
  formError.value = "";
  formFromAccount.value = detailOpen.value;
  if (detailOpen.value) {
    deferredForm.value = true;
    detailOpen.value = false;
  } else formOpen.value = true;
}
function openDeferredForm() {
  if (deferredForm.value) {
    deferredForm.value = false;
    formOpen.value = true;
  }
}
async function finishFormClose() {
  if (deferredCredential.value) {
    deferredCredential.value = false;
    credentialOpen.value = true;
    return;
  }
  if (!formFromAccount.value || !selected.value) return;
  formFromAccount.value = false;
  detailOpen.value = true;
  await loadDetail();
}
const stableId = (value: string, label: string) => {
  const text = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text) || text.length > 191)
    throw new Error(`请填写有效的${label}。`);
  return text;
};
async function submit() {
  formError.value = "";
  try {
    const request_key = crypto.randomUUID();
    if (formKind.value === "issuer") {
      if (!canManageIssuers.value) throw new Error("USAGE_FORBIDDEN");
      if (!form.label.trim() || !form.serviceIds.length)
        throw new Error("请填写来源名称，并至少选择一个模型服务。");
      if (!form.permissions.length)
        throw new Error("请至少选择一项服务端权限。");
      if (
        form.permissions.includes("allowance:grant") &&
        !form.permissions.includes("entitlements:write")
      )
        throw new Error("开通用量额度需要同时允许管理套餐状态。");
      await mutate({
        kind: "issuer",
        path: `${base}/issuers`,
        method: "POST",
        body: {
          id: stableId(form.id, "来源标识"),
          label: form.label.trim(),
          service_ids: [...form.serviceIds],
          account_ids: [...form.accountIds],
          permissions: [...form.permissions],
        },
      });
    } else if (formKind.value === "account") {
      if (!canWrite.value) throw new Error("USAGE_FORBIDDEN");
      if (!form.label.trim()) throw new Error("请填写共享账户名称。");
      await mutate({
        kind: "account",
        path: `${base}/accounts`,
        method: "POST",
        body: {
          request_key,
          source_id: request_key,
          kind: "organization",
          label: form.label.trim(),
          user_id: stableId(form.userId, "AI 使用人标识"),
        },
      });
    } else {
      if (!canWrite.value || selected.value?.kind !== "organization")
        throw new Error("USAGE_FORBIDDEN");
      const userId = stableId(form.userId, "AI 使用人标识");
      if (members.value.some((m) => m.userId === userId))
        throw new Error("此成员已存在；如已移除，请从成员列表恢复。");
      await mutate({
        kind: "member",
        path: `${base}/accounts/${segment(selected.value.id)}/members/${segment(userId)}`,
        method: "PUT",
        body: { request_key, expected_revision: 0, state: "active" },
      });
    }
  } catch (e) {
    formError.value = message(e);
  }
}
async function confirm(text: string) {
  try {
    await ElMessageBox.confirm(text, "确认操作", {
      confirmButtonText: "确认",
      cancelButtonText: "返回",
      type: "warning",
    });
    return true;
  } catch {
    return false;
  }
}
async function controlIssuer(issuer: Issuer, rotate: boolean) {
  if (!canManageIssuers.value) return;
  if (
    !(await confirm(
      rotate
        ? "轮换后原来源凭证与短期使用凭证失效。新凭证仅显示一次，请同步更新产品后端。"
        : "修改来源状态后，原短期使用凭证失效。原用量记录与在途结算仍保留。",
    ))
  )
    return;
  try {
    await mutate({
      kind: "issuer_control",
      path: `${base}/issuers/${segment(issuer.id)}/control`,
      method: "POST",
      body: {
        expected_revision: issuer.revision,
        state: rotate
          ? issuer.state
          : issuer.state === "active"
            ? "suspended"
            : "active",
        rotate,
      },
    });
  } catch (e) {
    error.value = message(e);
  }
}
async function restoreAccount(account: Account) {
  if (!canWrite.value || blocked.value || account.state !== 'archived' || !(await confirm('恢复原账户至停用状态；保留原套餐、已用额度和成员记录，不补发额度，不恢复旧使用凭证。需要使用时再启用账户。'))) return;
  try {
    await mutate({ kind: 'account_restore', path: `${base}/accounts/${segment(account.id)}/restore`, method: 'POST',
      body: { request_key: crypto.randomUUID(), expected_revision: account.revision } });
  } catch (e) { error.value = message(e); }
}
async function controlAccount() {
  const account = selected.value;
  if (
    !canWrite.value ||
    !account || account.state === "archived" ||
    !(await confirm(
      "更新账户状态会影响全部成员的后续模型请求，不修改原用量归属或业务授权。",
    ))
  )
    return;
  try {
    await mutate({
      kind: "account_control",
      path: `${base}/accounts/${segment(account.id)}/control`,
      method: "POST",
      body: {
        request_key: crypto.randomUUID(),
        expected_revision: account.revision,
        state: account.state === "active" ? "suspended" : "active",
      },
    });
  } catch (e) {
    detailError.value = message(e);
  }
}
async function controlMember(member: Member) {
  if (
    !canWrite.value ||
    selected.value?.kind !== "organization" || selected.value.state === "archived" ||
    !(await confirm(
      "更新此成员使用组织共享模型额度的资格；原用量和业务权限不变。",
    ))
  )
    return;
  try {
    await mutate({
      kind: "member_control",
      path: `${base}/accounts/${segment(selected.value.id)}/members/${segment(member.userId)}`,
      method: "PUT",
      body: {
        request_key: crypto.randomUUID(),
        expected_revision: member.revision,
        state: member.state === "active" ? "revoked" : "active",
      },
    });
  } catch (e) {
    detailError.value = message(e);
  }
}
const deletion = useUsageDeletion(message);
async function deleteResource(kind: "issuer" | "account", resource: Issuer | Account) {
  if (blocked.value || !canWrite.value || (kind === "issuer" && !canManageIssuers.value)) return;
  await deletion.show(`${base}/${kind === "issuer" ? "issuers" : "accounts"}/${encodeURIComponent(resource.id)}`, resource.label);
}
async function confirmDeleteResource() {
  const report = deletion.report.value;
  if (!report?.can_delete || deletion.loading.value || blocked.value || !canWrite.value) return;
  if (report.kind !== "issuer" && report.kind !== "account") return;
  if (report.kind === "issuer" && !canManageIssuers.value) return;
  try {
    await mutate({ kind: report.kind === "issuer" ? "issuer_delete" : "account_delete",
      method: "DELETE", path: deletion.path.value,
      body: { request_key: crypto.randomUUID(), expected_revision: report.revision } });
  } catch (e) { deletion.error.value = message(e); }
}
const storageKey = () =>
  `bailing:usage-access:pending:v1:${kernelMountPath()}:${me.me?.username || ""}`;
function validAttempt(value: unknown): value is Attempt {
  if (!value || typeof value !== "object") return false;
  const a = value as Attempt;
  if (
    !a.body ||
    typeof a.body !== "object" ||
    !["POST", "PUT", "DELETE"].includes(a.method)
  )
    return false;
  const path = a.path;
  if (typeof path !== "string") return false;
  return (
    (a.kind === "issuer_delete" && a.method === "DELETE" && /^\/admin\/api\/usage\/issuers\/[A-Za-z0-9_.:%-]+$/.test(path)) ||
    (a.kind === "account_delete" && a.method === "DELETE" && /^\/admin\/api\/usage\/accounts\/[A-Za-z0-9_.:%-]+$/.test(path)) ||
    (a.kind === "issuer" &&
      a.method === "POST" &&
      path === `${base}/issuers`) ||
    (a.kind === "account" &&
      a.method === "POST" &&
      path === `${base}/accounts`) ||
    (a.kind === "issuer_control" &&
      a.method === "POST" &&
      /^\/admin\/api\/usage\/issuers\/[A-Za-z0-9_.:%-]+\/control$/.test(
        path,
      )) ||
    (a.kind === "account_restore" && a.method === "POST" && /^\/admin\/api\/usage\/accounts\/[A-Za-z0-9_.:%-]+\/restore$/.test(path)) ||
    (a.kind === "account_control" &&
      a.method === "POST" &&
      /^\/admin\/api\/usage\/accounts\/[A-Za-z0-9_.:%-]+\/control$/.test(
        path,
      )) ||
    (["member", "member_control"].includes(a.kind) &&
      a.method === "PUT" &&
      /^\/admin\/api\/usage\/accounts\/[A-Za-z0-9_.:%-]+\/members\/[A-Za-z0-9_.:%-]+$/.test(
        path,
      ))
  );
}
async function mutate(attempt: Attempt) {
  if (blocked.value) throw new Error("请先完成上一次操作或等待刷新。");
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(attempt));
  } catch {
    storageFailed.value = true;
    throw new Error("无法保存原请求，本次尚未提交。请恢复会话存储后刷新。");
  }
  pending.value = attempt;
  await retryPending();
}
async function clearPending() {
  sessionStorage.removeItem(storageKey());
  pending.value = null;
}
const definitive = new Set([
  "USAGE_RESOURCE_IN_USE",
  "USAGE_RESOURCE_DELETED",
  "USAGE_RESOURCE_NOT_FOUND",
  "USAGE_INVALID_INPUT",
  "USAGE_FORBIDDEN",
  "USAGE_REVISION_CONFLICT",
  "USAGE_IDEMPOTENCY_CONFLICT",
  "USAGE_USER_NOT_FOUND",
  "USAGE_ACCOUNT_FORBIDDEN",
  "USAGE_ACCOUNT_NOT_FOUND",
  "USAGE_ACCOUNT_SUSPENDED",
  "USAGE_NOT_FOUND",
  "USAGE_UNSUPPORTED",
]);
async function retryPending() {
  if (!pending.value || saving.value) return;
  const attempt = pending.value;
  saving.value = true;
  error.value = "";
  try {
    const response = await api<{
      credential?: string | null;
      created?: boolean;
    }>(attempt.path, {
      method: attempt.method,
      body: JSON.stringify(attempt.body),
    });
    await clearPending();
    const wasFormOpen = formOpen.value;
    if (typeof response.credential === "string") {
      credential.value = response.credential;
      if (wasFormOpen) deferredCredential.value = true;
      else credentialOpen.value = true;
    } else if (attempt.kind === "issuer" && response.created === false) {
      ElMessage.warning(
        "来源已创建，凭证不再回显。若上次未保存，请轮换来源凭证后更新产品后端。",
      );
    } else if (attempt.kind.endsWith("_delete")) {
      deletion.open.value = false;
      if (attempt.kind === "account_delete" && selected.value && attempt.path.endsWith(`/${encodeURIComponent(selected.value.id)}`)) detailOpen.value = false;
      ElMessage.success(attempt.kind === "account_delete" ? "账户已移除，可在“已移除”中恢复原账户。" : "已删除，历史记录保留。");
    } else if (attempt.kind === "account_restore") ElMessage.success("原账户已恢复至停用状态；需要使用时请再启用。");
    else ElMessage.success("接入配置已保存。");
    formOpen.value = false;
    await load();
    if (detailOpen.value) await loadDetail();
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    let description = message(e);
    if (definitive.has(code)) {
      await clearPending();
      if (
        code === "USAGE_REVISION_CONFLICT" &&
        attempt.kind === "issuer_control" &&
        attempt.body.rotate === true
      )
        description =
          "来源修订已变化，无法恢复上次生成的凭证。已刷新当前来源，请重新轮换并安全保存新凭证。";
      await load();
      if (detailOpen.value) await loadDetail();
    }
    if (attempt.kind.endsWith("_delete") && deletion.open.value) {
      await deletion.refresh();
      deletion.error.value = description;
    }
    error.value = description;
    if (formOpen.value) formError.value = description;
    if (detailOpen.value) detailError.value = description;
  } finally {
    saving.value = false;
  }
}
async function copyCredential() {
  try {
    await navigator.clipboard.writeText(credential.value);
    ElMessage.success("已复制，请保存到可信产品后端。");
  } catch {
    ElMessage.warning("复制失败，请手动安全保存。");
  }
}
onMounted(() => {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey()) || "null");
    if (stored) {
      if (validAttempt(stored)) pending.value = stored;
      else {
        storageFailed.value = true;
        error.value = "原配置请求无法识别，请先核对当前记录。";
      }
    }
  } catch {
    storageFailed.value = true;
    error.value = "无法读取原配置请求，请恢复会话存储后刷新。";
  }
  void load();
});
</script>
<style scoped>
.usage-access {
  min-width: 0;
}
.usage-access :deep(.el-card__body) {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}
.page-title {
  display: flex;
  align-items: center;
  gap: 5px;
}
.detail {
  display: grid;
  gap: 22px;
}
.heading,
.section-heading,
.actions,
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.section-heading p {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.8;
  margin: 5px 0;
}
h2 {
  font-size: 20px;
  margin: 0 0 7px;
}
h3 {
  font-size: 16px;
  margin: 0;
}
.actions {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.section-heading {
  margin-bottom: 20px;
}
.panel {
  padding: 22px 25px;
  border: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-blank);
}
.pending {
  border-color: var(--el-color-warning);
}
.pending p,
.guide li,
.muted {
  font-size: 12px;
  line-height: 1.85;
  color: var(--el-text-color-secondary);
}
.guide {
  margin-top: 24px;
  border-left: 3px solid var(--el-color-primary);
}
.guide ol {
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.usage-access :deep(.el-select) {
  width: 100%;
}
.usage-access :deep(.el-tabs__content) {
  padding-top: 20px;
}
.permissions {
  display: grid;
  gap: 12px;
}
.permissions :deep(.el-checkbox) {
  height: auto;
  margin-right: 0;
  align-items: flex-start;
}
.permissions :deep(.el-checkbox__input) {
  margin-top: 3px;
}
.permissions :deep(.el-checkbox__label) {
  white-space: normal;
}
.permissions small {
  display: block;
  font-size: 11px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
  margin-top: 3px;
}
.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.drawer-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.access-config-drawer :deep(.el-drawer__footer) {
  border-top: 1px solid var(--el-border-color-light);
  padding: 16px 20px;
}
.access-config-drawer .form-grid {
  grid-template-columns: minmax(0, 1fr);
}
.access-config-drawer :deep(.el-select) {
  width: 100%;
}
.credential {
  margin-top: 20px;
}
.mono {
  overflow-wrap: anywhere;
}
.more {
  text-align: center;
  padding: 18px;
}
.detail .section-heading {
  margin: 0;
}
@media (max-width: 800px) {
  .heading,
  .section-heading {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .form-grid {
    grid-template-columns: 1fr;
  }
  .panel {
    padding: 18px;
  }
}
</style>
