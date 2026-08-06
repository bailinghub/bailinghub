import type { AppConfig } from '../../core/config/config';
import type { Pool } from 'mysql2/promise';
import { ClientRepository } from './config-client-repository';
import { CredentialRepository } from './config-credential-repository';
import { ChannelRepository } from './config-channel-repository';
import { RouteRepository } from './config-route-repository';
import { ToolProviderRepository } from './config-tool-provider-repository';
import { AdminRepository } from './config-admin-repository';
import { ProjectRepository } from './config-project-repository';
import { ExecutorTokenRepository } from './config-executor-token-repository';
import { TargetRepository } from './config-target-repository';
import { StorageBucketRepository } from './config-storage-bucket-repository';
import { AlertRuleRepository } from './config-alert-rule-repository';
import { ChatConfigRepository } from './config-chat-repository';
import { RateLimitLedger } from './config-rate-limit-ledger';
import { ApprovalLedger } from './config-approval-ledger';
import { ConversationLedger } from './config-conversation-ledger';
import { ExecutorLedger } from './config-executor-ledger';
import { ToolCallLedger } from './config-tool-call-ledger';
import { DeliveryDlqLedger } from './config-delivery-dlq-ledger';
import { ObservabilityLedger } from './config-observability-ledger';
import { MysqlToolEmbeddingRepository } from './config-tool-embedding-repository';
import type { ToolEmbeddingRepository } from '../../services/tool-index-repository';
import { MysqlKbDatasourceRepository, MysqlKnowledgeRepository } from './config-knowledge-repository';
import { InstanceBrandingRepository } from './config-instance-branding-repository';
import type { InstanceBrandingRepositoryContract } from './config-instance-branding-repository';
import { MysqlPoolOwner, type MysqlPoolResource } from '../mysql/pool-owner';

export type RouteRepositoryContract = Pick<RouteRepository, keyof RouteRepository>;
export type ClientRepositoryContract = Pick<ClientRepository, keyof ClientRepository>;
export type CredentialRepositoryContract = Pick<CredentialRepository, keyof CredentialRepository>;
export type ChannelRepositoryContract = Pick<ChannelRepository, keyof ChannelRepository>;
/** 新增的探针窄更新对旧扩展仓储保持可选；运行时可回退到既有 upsert。 */
export type ToolProviderRepositoryContract =
  Omit<Pick<ToolProviderRepository, keyof ToolProviderRepository>, 'updateSpecAccessProbe'>
  & Partial<Pick<ToolProviderRepository, 'updateSpecAccessProbe'>>;
export type AdminRepositoryContract = Pick<AdminRepository, keyof AdminRepository>;
export type ProjectRepositoryContract = Pick<ProjectRepository, keyof ProjectRepository>;
export type ExecutorTokenRepositoryContract = Pick<ExecutorTokenRepository, keyof ExecutorTokenRepository>;
export type TargetRepositoryContract = Pick<TargetRepository, keyof TargetRepository>;
export type StorageBucketRepositoryContract = Pick<StorageBucketRepository, keyof StorageBucketRepository>;
export type AlertRuleRepositoryContract = Pick<AlertRuleRepository, keyof AlertRuleRepository>;
export type ChatConfigRepositoryContract = Pick<ChatConfigRepository, keyof ChatConfigRepository>;
export type RateLimitLedgerContract = Pick<RateLimitLedger, keyof RateLimitLedger>;
export type ApprovalLedgerContract = Pick<ApprovalLedger, keyof ApprovalLedger>;
export type ConversationLedgerContract = Pick<ConversationLedger, keyof ConversationLedger>;
export type ExecutorLedgerContract = Pick<ExecutorLedger, keyof ExecutorLedger>;
export type ToolCallLedgerContract = Pick<ToolCallLedger, keyof ToolCallLedger>;
/** 公开扩展契约以稳定服务接口为准；事务 replaceProvider 对旧仓储保持可选。 */
export type ToolEmbeddingRepositoryContract = ToolEmbeddingRepository;
export type KnowledgeRepositoryContract = Pick<MysqlKnowledgeRepository, keyof MysqlKnowledgeRepository>;
export type KbDatasourceRepositoryContract = Pick<MysqlKbDatasourceRepository, keyof MysqlKbDatasourceRepository>;
export type { InstanceBrandingRepositoryContract };
export type DeliveryDlqLedgerContract = Pick<DeliveryDlqLedger, keyof DeliveryDlqLedger>;
export type ObservabilityLedgerContract =
  Omit<Pick<ObservabilityLedger, keyof ObservabilityLedger>, 'operationalMetricsSnapshot'>
  & Partial<Pick<ObservabilityLedger, 'operationalMetricsSnapshot'>>;

export interface ConfigStoreContract {
  readonly routes: RouteRepositoryContract;
  readonly clients: ClientRepositoryContract;
  readonly credentials: CredentialRepositoryContract;
  readonly channels: ChannelRepositoryContract;
  readonly toolProviders: ToolProviderRepositoryContract;
  readonly admins: AdminRepositoryContract;
  readonly projects: ProjectRepositoryContract;
  readonly executorTokens: ExecutorTokenRepositoryContract;
  readonly targets: TargetRepositoryContract;
  readonly storageBuckets: StorageBucketRepositoryContract;
  readonly alertRules: AlertRuleRepositoryContract;
  readonly chatEntries: ChatConfigRepositoryContract;
  readonly rateLimits: RateLimitLedgerContract;
  readonly approvals: ApprovalLedgerContract;
  readonly conversations: ConversationLedgerContract;
  readonly executors: ExecutorLedgerContract;
  readonly toolCalls: ToolCallLedgerContract;
  readonly toolEmbeddings: ToolEmbeddingRepositoryContract;
  readonly knowledge: KnowledgeRepositoryContract;
  readonly kbDatasources: KbDatasourceRepositoryContract;
  readonly instanceBranding: InstanceBrandingRepositoryContract;
  readonly deliveryDlq: DeliveryDlqLedgerContract;
  readonly observability: ObservabilityLedgerContract;
  init(): Promise<void>;
  close?(): Promise<void>;
  readonly db: Pool;
}

/** web 后台配置（项目/路由/会话映射）的读写。需要 mysql 后端。 */
export class ConfigStore implements ConfigStoreContract {
  private pool!: Pool;
  private readonly poolOwner: MysqlPoolResource;
  readonly routes = new RouteRepository(() => this.pool);
  readonly clients = new ClientRepository(() => this.pool);
  readonly credentials = new CredentialRepository(() => this.pool);
  readonly channels = new ChannelRepository(() => this.pool);
  readonly toolProviders = new ToolProviderRepository(() => this.pool);
  readonly admins = new AdminRepository(() => this.pool);
  readonly projects = new ProjectRepository(() => this.pool);
  readonly executorTokens = new ExecutorTokenRepository(() => this.pool);
  readonly targets = new TargetRepository(() => this.pool);
  readonly storageBuckets = new StorageBucketRepository(() => this.pool);
  readonly alertRules = new AlertRuleRepository(() => this.pool);
  readonly chatEntries = new ChatConfigRepository(() => this.pool);
  readonly rateLimits = new RateLimitLedger(() => this.pool);
  readonly approvals = new ApprovalLedger(() => this.pool);
  readonly conversations = new ConversationLedger(() => this.pool);
  readonly executors = new ExecutorLedger(() => this.pool);
  readonly toolCalls = new ToolCallLedger(() => this.pool);
  readonly toolEmbeddings = new MysqlToolEmbeddingRepository(() => this.pool);
  readonly knowledge = new MysqlKnowledgeRepository(() => this.pool);
  readonly kbDatasources = new MysqlKbDatasourceRepository(() => this.pool);
  readonly instanceBranding = new InstanceBrandingRepository(() => this.pool);
  readonly deliveryDlq = new DeliveryDlqLedger(() => this.pool);
  readonly observability = new ObservabilityLedger(() => this.pool);

  constructor(cfg: AppConfig['state']['mysql'], poolOwner?: MysqlPoolResource) {
    this.poolOwner = poolOwner ?? new MysqlPoolOwner(cfg);
  }

  async init(): Promise<void> {
    this.pool = await this.poolOwner.get();
  }

  async close(): Promise<void> {
    await this.poolOwner.close();
  }

  /** 共享连接池（KbService 等同库模块复用，不开第二个池） */
  get db(): Pool { return this.pool; }
}
