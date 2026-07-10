import { createRuntimeContext, type RuntimeActor, type RuntimeContext, type RuntimeSource } from './context';

export interface ScopeResolveInput<AuthResult = unknown> {
  source: RuntimeSource;
  requestId: string;
  auth?: AuthResult;
  actor?: RuntimeActor;
}

export interface ScopeResolver<AuthResult = unknown> {
  resolve(input: ScopeResolveInput<AuthResult>): Promise<RuntimeContext>;
}

export class SingleScopeResolver<AuthResult = unknown> implements ScopeResolver<AuthResult> {
  constructor(private readonly actorOf?: (auth: AuthResult | undefined) => RuntimeActor | undefined) {}

  async resolve(input: ScopeResolveInput<AuthResult>): Promise<RuntimeContext> {
    return createRuntimeContext({
      source: input.source,
      requestId: input.requestId,
      actor: input.actor ?? this.actorOf?.(input.auth),
    });
  }
}
