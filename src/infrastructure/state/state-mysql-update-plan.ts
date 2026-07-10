import type { Job } from '../../core/contracts/types';
import { dt, json } from '../../core/state/state-codec';

type SqlValue = string | number | null;

interface PatchColumn {
  field: keyof Job;
  column: string;
  nullable: boolean;
  encode(value: unknown): SqlValue;
}

const raw = (value: unknown): SqlValue => value === undefined || value === null ? null : String(value);
const num = (value: unknown): SqlValue => value === undefined || value === null ? null : Number(value);
const date = (value: unknown): SqlValue => value === undefined || value === null || value === '' ? null : dt(String(value));
const jsonValue = (value: unknown): SqlValue => json(value);

const PATCH_COLUMNS: PatchColumn[] = [
  { field: 'status', column: 'status', nullable: false, encode: raw },
  { field: 'target', column: 'target', nullable: true, encode: raw },
  { field: 'profile', column: 'profile', nullable: false, encode: raw },
  { field: 'project', column: 'project', nullable: false, encode: raw },
  { field: 'source', column: 'source', nullable: false, encode: raw },
  { field: 'client_app_id', column: 'client_app_id', nullable: true, encode: raw },
  { field: 'thread_id', column: 'thread_id', nullable: true, encode: num },
  { field: 'session_id', column: 'session_id', nullable: true, encode: raw },
  { field: 'input_preview', column: 'input_preview', nullable: false, encode: raw },
  { field: 'input', column: 'input', nullable: true, encode: raw },
  { field: 'dispatch', column: 'dispatch', nullable: true, encode: jsonValue },
  { field: 'attempts', column: 'attempts', nullable: false, encode: num },
  { field: 'run_after', column: 'run_after', nullable: true, encode: date },
  { field: 'claimed_at', column: 'claimed_at', nullable: true, encode: date },
  { field: 'lease_until', column: 'lease_until', nullable: true, encode: date },
  { field: 'report', column: 'report', nullable: true, encode: jsonValue },
  { field: 'result', column: 'result', nullable: true, encode: jsonValue },
  { field: 'raw_result', column: 'raw_result', nullable: true, encode: raw },
  { field: 'usage', column: '`usage`', nullable: true, encode: jsonValue },
  { field: 'error', column: 'error', nullable: true, encode: raw },
  { field: 'metadata', column: 'metadata', nullable: true, encode: jsonValue },
  { field: 'callback_url', column: 'callback_url', nullable: true, encode: raw },
  { field: 'executor_id', column: 'executor_id', nullable: true, encode: raw },
  { field: 'dispatched_at', column: 'dispatched_at', nullable: true, encode: date },
  { field: 'claim_token', column: 'claim_token', nullable: true, encode: raw },
];

export interface MysqlJobUpdatePlan {
  assignments: string[];
  values: SqlValue[];
}

export function mysqlJobUpdatePlan(patch: Partial<Job>, updatedAtIso: string): MysqlJobUpdatePlan {
  const assignments: string[] = [];
  const values: SqlValue[] = [];
  for (const col of PATCH_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(patch, col.field)) continue;
    if (patch[col.field] === undefined && !col.nullable) continue;
    assignments.push(`${col.column}=?`);
    values.push(col.encode(patch[col.field]));
  }
  assignments.push('updated_at=?');
  values.push(dt(updatedAtIso));
  return { assignments, values };
}
