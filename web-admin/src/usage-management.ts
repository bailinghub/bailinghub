export interface ServiceReferenceAccount {
  id: string; label: string; kind: 'personal' | 'organization'; state: 'active' | 'suspended';
  grantId: string; grantLabel: string; sourceOwner: string; serviceIds: string[]; revision: number;
}
export interface ServiceReferenceRequest {
  accountId: string; accountLabel: string; operationId: string; state: string; resultState: string;
}
export interface ServiceReferenceReport {
  service: { id: string; label: string; revision: number }; deletable: boolean;
  plans: { total: number; truncated: boolean; items: Array<{id: string; label: string}> };
  accounts: { total: number; truncated: boolean; items: ServiceReferenceAccount[] };
  requests: { total: number; truncated: boolean; items: ServiceReferenceRequest[] };
}
