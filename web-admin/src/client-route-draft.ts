interface ClientDraftForm {
  app_id: string; name: string; agent_authorize_url: string; allowed_routes: string[]; allowed_channels: string[];
  rate_limit_per_min: number; description: string; enabled: boolean;
}
export interface ClientRouteDraft {
  form: ClientDraftForm;
  budget: { enabled: boolean; window: 'hour' | 'day' | 'month'; hard_cost_usd?: number; hard_tokens?: number };
  budgetRest: Record<string, unknown>;
  editing: boolean;
  baseline: string;
}

// One dependency detour in this tab only. No token/secret fields, localStorage,
// sessionStorage, URL payload or cross-account restoration.
let draft: { owner: string; value: ClientRouteDraft } | undefined;
export function rememberClientRouteDraft(owner: string, value: ClientRouteDraft): void {
  const { app_id, name, agent_authorize_url, allowed_routes, allowed_channels, rate_limit_per_min, description, enabled } = value.form;
  const safe = { ...value, form: { app_id, name, agent_authorize_url, allowed_routes, allowed_channels, rate_limit_per_min, description, enabled } };
  draft = { owner, value: JSON.parse(JSON.stringify(safe)) as ClientRouteDraft };
}
export function takeClientRouteDraft(owner: string): ClientRouteDraft | undefined {
  const saved = draft; draft = undefined;
  return saved?.owner === owner ? saved.value : undefined;
}
export function hasClientRouteDraft(owner: string): boolean { return draft?.owner === owner; }
