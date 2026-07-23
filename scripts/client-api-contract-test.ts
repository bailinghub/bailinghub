import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { JOB_STATUSES, TERMINAL_JOB_STATUSES } from '../src/core/contracts/types';
import { CONTRACT_VERSIONS } from '../src/core/platform/version';

interface ContractManifest {
  contract: string;
  version: string;
  major: number;
  endpoints: Array<{
    id: string;
    method: string;
    path: string;
    authentication: string;
    request_schema?: string;
    response_schema: string;
  }>;
  error_schema: string;
  job_statuses: {
    known: string[];
    non_terminal: string[];
    terminal: string[];
  };
  vectors: string;
}

interface ContractVectors {
  contract: string;
  version: string;
  cases: Array<{
    id: string;
    schema: string;
    valid: boolean;
    value: unknown;
  }>;
}

const root = resolve(import.meta.dirname, '..');
const contractDir = resolve(root, 'contracts/client-api/v1');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const manifest = readJson<ContractManifest>(resolve(contractDir, 'manifest.json'));
const vectors = readJson<ContractVectors>(resolve(contractDir, manifest.vectors));

assert.equal(manifest.contract, 'bailing.client-api');
assert.equal(manifest.major, 1);
assert.match(manifest.version, /^1\.\d+\.\d+$/);
assert.equal(CONTRACT_VERSIONS.clientApi, `bailing.client-api.v${manifest.major}`);
assert.equal(vectors.contract, manifest.contract);
assert.equal(vectors.version, manifest.version);
assert.deepEqual(manifest.job_statuses.known, [...JOB_STATUSES]);
assert.deepEqual(manifest.job_statuses.terminal, [...TERMINAL_JOB_STATUSES]);
assert.deepEqual(
  manifest.job_statuses.non_terminal,
  JOB_STATUSES.filter((status) => !TERMINAL_JOB_STATUSES.includes(status as (typeof TERMINAL_JOB_STATUSES)[number])),
);
assert.deepEqual(
  new Set(manifest.endpoints.map((endpoint) => endpoint.id)),
  new Set(['health', 'run.submit', 'jobs.get']),
);
assert.deepEqual(
  manifest.endpoints.map(({ id, method, path, authentication }) => ({
    id,
    method,
    path,
    authentication,
  })),
  [
    { id: 'health', method: 'GET', path: '/health', authentication: 'none' },
    { id: 'run.submit', method: 'POST', path: '/run', authentication: 'bearer' },
    {
      id: 'jobs.get',
      method: 'GET',
      path: '/jobs/{job_id}',
      authentication: 'bearer',
    },
  ],
);

const runRequestSchema = readJson<{
  properties: Record<string, { maxLength?: number }>;
}>(resolve(contractDir, 'run-request.schema.json'));
assert.equal(runRequestSchema.properties.request_id?.maxLength, 128);
assert.equal(runRequestSchema.properties.route?.maxLength, 64);
assert.equal(runRequestSchema.properties.input?.maxLength, 100_000);

const schemaNames = new Set<string>([manifest.error_schema]);
for (const endpoint of manifest.endpoints) {
  schemaNames.add(endpoint.response_schema);
  if (endpoint.request_schema) schemaNames.add(endpoint.request_schema);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
for (const schemaName of schemaNames) {
  validators.set(schemaName, ajv.compile(readJson(resolve(contractDir, schemaName))));
}

for (const vector of vectors.cases) {
  const validate = validators.get(vector.schema);
  assert.ok(validate, `${vector.id}: undeclared schema ${vector.schema}`);
  const actual = validate(vector.value);
  assert.equal(
    actual,
    vector.valid,
    `${vector.id}: expected valid=${vector.valid}, errors=${JSON.stringify(validate.errors)}`,
  );
}

const aliases = new Map([
  ['schemas/api/run-request.schema.json', '../../contracts/client-api/v1/run-request.schema.json'],
  ['schemas/api/run-response.schema.json', '../../contracts/client-api/v1/submit-response.schema.json'],
  ['schemas/api/job-response.schema.json', '../../contracts/client-api/v1/job-response.schema.json'],
]);
for (const [path, expectedRef] of aliases) {
  const alias = readJson<{ $ref?: string }>(resolve(root, path));
  assert.equal(alias.$ref, expectedRef, `${path}: stale compatibility alias`);
}

console.log(`PASS: ${manifest.contract} ${manifest.version} (${vectors.cases.length} vectors)`);
