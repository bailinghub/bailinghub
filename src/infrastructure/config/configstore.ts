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
import { MysqlKbDatasourceRepository, MysqlKnowledgeRepository } from './config-knowledge-repository';

export type RouteRepositoryContract = Pick<RouteRepository, keyof RouteRepository>;
export type ClientRepositoryContract = Pick<ClientRepository, keyof ClientRepository>;
export type CredentialRepositoryContract = Pick<CredentialRepository, keyof CredentialRepository>;
export type ChannelRepositoryContract = Pick<ChannelRepository, keyof ChannelRepository>;
export type ToolProviderRepositoryContract = Pick<ToolProviderRepository, keyof ToolProviderRepository>;
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
export type ToolEmbeddingRepositoryContract = Pick<MysqlToolEmbeddingRepository, keyof MysqlToolEmbeddingRepository>;
export type KnowledgeRepositoryContract = Pick<MysqlKnowledgeRepository, keyof MysqlKnowledgeRepository>;
export type KbDatasourceRepositoryContract = Pick<MysqlKbDatasourceRepository, keyof MysqlKbDatasourceRepository>;
export type DeliveryDlqLedgerContract = Pick<DeliveryDlqLedger, keyof DeliveryDlqLedger>;
export type ObservabilityLedgerContract = Pick<ObservabilityLedger, keyof ObservabilityLedger>;

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
  readonly deliveryDlq: DeliveryDlqLedgerContract;
  readonly observability: ObservabilityLedgerContract;
  init(): Promise<void>;
  readonly db: Pool;
}

/** web 后台配置（项目/路由/会话映射）的读写。需要 mysql 后端。 */
export class ConfigStore implements ConfigStoreContract {
  private pool!: Pool;
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
  readonly deliveryDlq = new DeliveryDlqLedger(() => this.pool);
  readonly observability = new ObservabilityLedger(() => this.pool);

  constructor(private readonly cfg: AppConfig['state']['mysql']) {}

  async init(): Promise<void> {
    const mysql = await import('mysql2/promise');
    this.pool = mysql.createPool({
      host: this.cfg.host, port: this.cfg.port, user: this.cfg.user,
      password: this.cfg.password, database: this.cfg.database,
      waitForConnections: true, connectionLimit: this.cfg.connectionLimit,
      timezone: 'Z', // 全链路 UTC（同 state.ts；严禁 SQL NOW() 与 dt() 列比较）
    });
  }

  /** 共享连接池（KbService 等同库模块复用，不开第二个池） */
  get db(): Pool { return this.pool; }
}
