export const OSS_EDITION = 'oss';
export const SINGLE_SCOPE_KIND = 'single';
export const SINGLE_SCOPE_ID = 'default';
export const SINGLE_SCOPE_CAPABILITY = 'single_org';

export type RuntimeSource =
  | 'admin'
  | 'run'
  | 'send'
  | 'chat'
  | 'channel'
  | 'executor'
  | 'worker'
  | 'system';

export interface RuntimeScope {
  kind: string;
  id: string;
  projectId?: string;
  capabilities: string[];
}

export interface RuntimeActor {
  kind: string;
  id: string;
  roles: string[];
  displayName?: string;
}

export interface RuntimeContext {
  edition: string;
  scope: RuntimeScope;
  actor: RuntimeActor;
  requestId: string;
  source: RuntimeSource;
}

export function singleScope(): RuntimeScope {
  return {
    kind: SINGLE_SCOPE_KIND,
    id: SINGLE_SCOPE_ID,
    capabilities: [SINGLE_SCOPE_CAPABILITY],
  };
}

export function systemActor(id = 'system'): RuntimeActor {
  return {
    kind: 'system',
    id,
    roles: ['system'],
  };
}

export function createRuntimeContext(input: {
  edition?: string;
  scope?: RuntimeScope;
  actor?: RuntimeActor;
  requestId: string;
  source: RuntimeSource;
}): RuntimeContext {
  return {
    edition: input.edition ?? OSS_EDITION,
    scope: input.scope ?? singleScope(),
    actor: input.actor ?? systemActor(),
    requestId: input.requestId,
    source: input.source,
  };
}

export function isSingleScope(scope: RuntimeScope): boolean {
  return scope.kind === SINGLE_SCOPE_KIND && scope.id === SINGLE_SCOPE_ID;
}

export function assertSingleScope(ctx: RuntimeContext): void {
  if (!isSingleScope(ctx.scope)) {
    throw new Error(`当前开源版只支持 single/default scope，收到 ${ctx.scope.kind}/${ctx.scope.id}`);
  }
}
