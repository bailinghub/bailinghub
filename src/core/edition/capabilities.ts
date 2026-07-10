export interface ConsoleCapabilities {
  edition: string;
  console: 'single' | string;
  modules: string[];
  limits: Record<string, unknown>;
}
