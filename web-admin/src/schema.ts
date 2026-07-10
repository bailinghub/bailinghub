import { computed, ref } from 'vue';
import { api } from './request';

export interface ConfigSchema {
  required?: string[];
  properties?: Record<string, ConfigSchemaProperty>;
}

export interface ConfigSchemaProperty {
  title?: string;
  description?: string;
  type?: string;
  enum?: string[];
  $ref?: string;
  properties?: Record<string, ConfigSchemaProperty>;
}

const cache = new Map<string, ConfigSchema>();

export function useConfigSchema(name: string) {
  const schema = ref<ConfigSchema | null>(cache.get(name) ?? null);
  async function load(): Promise<void> {
    if (schema.value) return;
    const s = await api<ConfigSchema>('/admin/api/config-schemas/' + encodeURIComponent(name));
    cache.set(name, s);
    schema.value = s;
  }
  const required = computed(() => new Set(schema.value?.required ?? []));
  return { schema, required, load };
}

function schemaProperty(schema: ConfigSchema | null, field: string): ConfigSchemaProperty | undefined {
  let props = schema?.properties;
  let cur: ConfigSchemaProperty | undefined;
  for (const part of field.split('.')) {
    cur = props?.[part];
    props = cur?.properties;
  }
  return cur;
}

export function schemaTitle(schema: ConfigSchema | null, field: string, fallback: string): string {
  return schemaProperty(schema, field)?.title || fallback;
}

export function schemaDescription(schema: ConfigSchema | null, field: string, fallback = ''): string {
  return schemaProperty(schema, field)?.description || fallback;
}

export function schemaRequired(required: Set<string>, field: string): boolean {
  return required.has(field);
}
