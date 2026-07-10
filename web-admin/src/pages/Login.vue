<template>
  <div class="wrap">
    <div class="loginShell">
      <section class="loginPanel">
        <section class="hero">
          <BrandLockup class="brandLockup" />
          <div class="heroText">
            <p class="eyebrow">AI CONTROL PLANE</p>
            <h1>把业务系统接成可治理的 AI 操作入口</h1>
            <p>从触发路由、工具声明、审批意图到审计追溯，所有运行痕迹留在自己的控制台里。</p>
          </div>
          <div class="heroGrid">
            <div><b>Routes</b><span>场景路由</span></div>
            <div><b>Tools</b><span>工具治理</span></div>
            <div><b>Trace</b><span>全链路追溯</span></div>
          </div>
        </section>

        <section class="auth">
          <div class="authInner">
            <div class="cardHead">
              <p>控制台登录</p>
              <h2>登录百灵中枢</h2>
              <span>{{ signupEnabled ? '使用邮箱注册或登录账号，进入你的独立中枢控制台。' : '请输入管理员账号，进入你的中枢控制台。' }}</span>
            </div>
            <div v-if="signupEnabled" class="tabs" role="tablist">
              <button class="tab" :class="{ active: mode === 'login' }" type="button" @click="mode = 'login'">登录</button>
              <button class="tab" :class="{ active: mode === 'signup' }" type="button" @click="mode = 'signup'">{{ signupTitle }}</button>
            </div>
            <el-form v-if="mode === 'login'" class="loginForm" @submit.prevent="submit">
              <el-form-item><el-input v-model="username" :placeholder="loginAccountPlaceholder" autocomplete="username" size="large" /></el-form-item>
              <el-form-item><el-input v-model="password" type="password" placeholder="密码" show-password autocomplete="current-password" size="large" @keyup.enter="submit" /></el-form-item>
              <el-alert v-if="err" :title="err" type="error" :closable="false" style="margin-bottom: 12px" />
              <el-button type="primary" size="large" class="submit" :loading="loading" @click="submit">登录控制台</el-button>
            </el-form>
            <el-form v-else class="loginForm" @submit.prevent="signup">
              <el-form-item><el-input v-model="signupEmail" placeholder="邮箱" autocomplete="email" size="large" /></el-form-item>
              <el-form-item><el-input v-model="displayName" placeholder="显示名称 / 团队名" autocomplete="name" size="large" /></el-form-item>
              <el-form-item><el-input v-model="signupPassword" type="password" :placeholder="`至少 ${signupPasswordMinLength} 位密码`" show-password autocomplete="new-password" size="large" @keyup.enter="signup" /></el-form-item>
              <el-form-item v-if="signupVerificationRequired">
                <div class="codeRow">
                  <el-input v-model="signupCode" placeholder="邮箱验证码" autocomplete="one-time-code" size="large" @keyup.enter="signup" />
                  <el-button size="large" :disabled="signupCountdown > 0" :loading="sendingCode" @click="sendSignupCode">
                    {{ signupCountdown > 0 ? `${signupCountdown}s` : '发送验证码' }}
                  </el-button>
                </div>
              </el-form-item>
              <el-alert v-if="err" :title="err" type="error" :closable="false" style="margin-bottom: 12px" />
              <el-button type="primary" size="large" class="submit" :loading="loading" @click="signup">创建并进入控制台</el-button>
            </el-form>
            <p class="footnote">{{ signupEnabled ? '系统会为注册账号创建独立控制台；生产接入前请确认资源额度和安全策略。' : '开源自托管实例由你自己掌控；生产环境请在首次部署后修改管理员密码。' }}</p>
          </div>
        </section>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMe } from '../store';
import BrandLockup from '../components/BrandLockup.vue';

const username = ref('');
const password = ref('');
const signupEmail = ref('');
const signupPassword = ref('');
const displayName = ref('');
const err = ref('');
const loading = ref(false);
const signupEnabled = ref(false);
const signupTitle = ref('注册租户');
const signupVerificationRequired = ref(true);
const signupPasswordMinLength = ref(8);
const signupMailReady = ref(false);
const signupCode = ref('');
const sendingCode = ref(false);
const signupCountdown = ref(0);
const mode = ref<'login' | 'signup'>('login');
const loginAccountPlaceholder = computed(() => signupEnabled.value ? '邮箱' : '管理员账号');
const router = useRouter();
const route = useRoute();
const resolvedTenantId = ref(typeof route.query['tenant'] === 'string' ? route.query['tenant'] : '');
const s = useMe();
const queryEmail = typeof route.query['email'] === 'string' ? route.query['email'] : '';
if (queryEmail) {
  username.value = queryEmail;
  signupEmail.value = queryEmail;
}

onMounted(() => {
  void loadSignupConfig();
});

let signupCountdownTimer: ReturnType<typeof setInterval> | undefined;

onBeforeUnmount(() => {
  if (signupCountdownTimer) clearInterval(signupCountdownTimer);
});

function loginUrl(): string {
  const tenantId = resolvedTenantId.value || (typeof route.query['tenant'] === 'string' ? route.query['tenant'] : '');
  return tenantId ? `/admin/login?tenant=${encodeURIComponent(tenantId)}` : '/admin/login';
}

async function loadSignupConfig(): Promise<void> {
  try {
    const r = await fetch('/admin/signup-config');
    if (!r.ok) return;
    const j = (await r.json().catch(() => ({}))) as {
      enabled?: boolean;
      title?: string;
      password_min_length?: number;
      verification_required?: boolean;
      mail_ready?: boolean;
    };
    signupEnabled.value = j.enabled === true;
    if (j.title) signupTitle.value = j.title;
    signupPasswordMinLength.value = Number(j.password_min_length || 8);
    signupVerificationRequired.value = j.verification_required !== false;
    signupMailReady.value = j.mail_ready === true;
  } catch {
    signupEnabled.value = false;
  }
}

function startSignupCountdown(seconds: number): void {
  signupCountdown.value = Math.max(0, Math.floor(seconds));
  if (signupCountdownTimer) clearInterval(signupCountdownTimer);
  if (signupCountdown.value <= 0) return;
  signupCountdownTimer = setInterval(() => {
    signupCountdown.value -= 1;
    if (signupCountdown.value <= 0 && signupCountdownTimer) {
      clearInterval(signupCountdownTimer);
      signupCountdownTimer = undefined;
    }
  }, 1000);
}

async function submit(): Promise<void> {
  if (!username.value || !password.value) { err.value = '用户名/密码必填'; return; }
  loading.value = true; err.value = '';
  try {
    const r = await fetch(loginUrl(), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) { err.value = j.error || '登录失败'; return; }
    await s.fetch();
    void router.replace({ path: '/', query: route.query });
  } finally { loading.value = false; }
}

async function signup(): Promise<void> {
  if (!signupEmail.value || !signupPassword.value) { err.value = '邮箱/密码必填'; return; }
  if (signupPassword.value.length < signupPasswordMinLength.value) { err.value = `密码至少 ${signupPasswordMinLength.value} 位`; return; }
  if (signupVerificationRequired.value && !signupCode.value.trim()) { err.value = '请先填写邮箱验证码'; return; }
  loading.value = true; err.value = '';
  try {
    const r = await fetch('/admin/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: signupEmail.value,
        password: signupPassword.value,
        display_name: displayName.value,
        verification_code: signupCode.value,
      }),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string; login_email?: string; tenant_id?: string };
    if (!r.ok) { err.value = j.error || '注册失败'; return; }
    if (j.tenant_id) resolvedTenantId.value = j.tenant_id;
    username.value = j.login_email || signupEmail.value;
    password.value = signupPassword.value;
    mode.value = 'login';
    await submit();
  } finally {
    loading.value = false;
  }
}

async function sendSignupCode(): Promise<void> {
  if (!signupEmail.value) { err.value = '请先填写邮箱'; return; }
  if (signupVerificationRequired.value && !signupMailReady.value) { err.value = '注册邮件暂未配置，请稍后再试'; return; }
  sendingCode.value = true; err.value = '';
  try {
    const r = await fetch('/admin/signup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: signupEmail.value }),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string; expires_in_seconds?: number; verification_required?: boolean };
    if (!r.ok) { err.value = j.error || '验证码发送失败'; return; }
    signupVerificationRequired.value = j.verification_required !== false;
    startSignupCountdown(Number(j.expires_in_seconds || 60));
  } finally {
    sendingCode.value = false;
  }
}
</script>

<style scoped>
.wrap {
  min-height: 100%;
  background:
    linear-gradient(90deg, rgba(63, 185, 80, .08), transparent 44%),
    radial-gradient(900px 520px at 16% 16%, rgba(63, 185, 80, .16), transparent 62%),
    var(--el-bg-color-page);
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
}
.loginShell {
  width: min(1280px, calc(100% - 64px));
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
}
.loginPanel {
  display: grid;
  grid-template-columns: minmax(0, 1.16fr) minmax(0, .84fr);
}
.hero {
  padding: clamp(26px, 4vw, 52px);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  border-right: 1px solid var(--el-border-color);
  background:
    linear-gradient(135deg, rgba(63, 185, 80, .12), transparent 46%),
    var(--el-bg-color-page);
}
.auth {
  display: grid;
  place-items: center;
  padding: clamp(26px, 4vw, 52px);
}
.brandLockup {
  width: 144px;
  height: 58px;
  transform: scale(1.08);
  transform-origin: left center;
}
.heroText { max-width: 680px; }
.eyebrow { margin: 0 0 16px; color: #3fb950; font-family: var(--bz-mono); font-weight: 800; letter-spacing: .18em; }
h1 { margin: 0; font-size: clamp(42px, 4.1vw, 58px); line-height: 1.04; letter-spacing: 0; font-weight: 900; }
.heroText > p:last-child { margin: 24px 0 0; max-width: 600px; color: var(--el-text-color-secondary); font-size: 16px; line-height: 1.9; }
.heroGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--el-border-color); max-width: 720px; }
.heroGrid div { padding: 18px 20px; border-right: 1px solid var(--el-border-color-lighter); background: rgba(255,255,255,.02); }
.heroGrid div:last-child { border-right: 0; }
.heroGrid b { display: block; font-family: var(--bz-mono); color: #3fb950; letter-spacing: .08em; }
.heroGrid span { display: block; margin-top: 8px; color: var(--el-text-color-secondary); }
.authInner {
  width: min(100%, 420px);
}
.cardHead { margin-bottom: 26px; }
.cardHead p { margin: 0 0 12px; color: #3fb950; font-family: var(--bz-mono); font-size: 12px; font-weight: 800; letter-spacing: .16em; }
.cardHead h2 { margin: 0; font-size: 30px; line-height: 1.2; }
.cardHead span { display: block; margin-top: 10px; color: var(--el-text-color-secondary); line-height: 1.7; }
.tabs {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid var(--el-border-color);
  margin-bottom: 18px;
}
.tab {
  height: 40px;
  border: 0;
  border-right: 1px solid var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}
.tab:last-child { border-right: 0; }
.tab.active {
  background: rgba(63, 185, 80, .16);
  color: #56d364;
}
.loginForm { width: 100%; }
.codeRow {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 126px;
  gap: 10px;
}
.submit { width: 100%; }
.footnote { margin: 16px 0 0; color: var(--el-text-color-placeholder); font-size: 12px; line-height: 1.7; }
@media (max-width: 980px) {
  .wrap { padding: 16px; }
  .loginShell {
    width: 100%;
    min-height: auto;
  }
  .loginPanel {
    grid-template-columns: 1fr;
  }
  .hero { border-right: 0; border-bottom: 1px solid var(--el-border-color); padding: 28px 20px 24px; min-height: auto; }
  .auth { padding: 28px 20px; }
}
@media (max-width: 640px) {
  .heroGrid { grid-template-columns: 1fr; }
  .heroGrid div { border-right: 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .heroGrid div:last-child { border-bottom: 0; }
  .authInner { width: 100%; }
  .cardHead h2 { font-size: 26px; }
}
</style>
