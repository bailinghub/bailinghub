import type { BootstrapAdminConfig } from '../core/config/config';
import { hashPassword } from '../core/platform/password';

export type InitialAdminCreateResult = 'created' | 'existing';

export interface InitialAdminRepository {
  hasAny(): Promise<boolean>;
  createInitial(
    username: string,
    passwordHash: string,
    displayName: string,
    role: 'admin',
  ): Promise<InitialAdminCreateResult>;
}

export interface BootstrapInitialAdminDeps {
  admins: InitialAdminRepository | null;
  hash?: (password: string) => Promise<string>;
  logger?: Pick<Console, 'log'>;
}

export type BootstrapInitialAdminResult = 'disabled' | InitialAdminCreateResult;

/**
 * 首次管理员启动契约。
 *
 * 它只负责把已经过配置层校验的凭据交给原子仓储方法；账号已存在时绝不更新
 * 密码、角色或启用状态。显式创建和密码重置继续由独立管理入口负责。
 */
export async function bootstrapInitialAdmin(
  config: BootstrapAdminConfig | null,
  deps: BootstrapInitialAdminDeps,
): Promise<BootstrapInitialAdminResult> {
  if (!config) return 'disabled';
  if (!deps.admins) throw new Error('首次管理员初始化需要可用的配置存储');

  const logger = deps.logger ?? console;
  if (await deps.admins.hasAny()) {
    logger.log('[百灵中枢] 已存在后台管理员，跳过首次账号初始化');
    return 'existing';
  }

  const passwordHash = await (deps.hash ?? hashPassword)(config.password);
  const result = await deps.admins.createInitial(config.username, passwordHash, config.username, 'admin');
  if (result === 'created') logger.log(`[百灵中枢] 已创建首次后台管理员：${config.username}`);
  else logger.log('[百灵中枢] 已存在后台管理员，跳过首次账号初始化');
  return result;
}
