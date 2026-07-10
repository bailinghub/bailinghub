import type { Job } from '../core/contracts/types';
import { cfgStore } from './runtime';
import { resolveSendChannelsFor, runSendMessageFor } from './builtin-tools';

export async function resolveSendChannels(tcfg: Record<string, unknown> | undefined): Promise<string[]> {
  return resolveSendChannelsFor(cfgStore, tcfg);
}

export async function runSendMessage(
  job: Job,
  allowedChannels: string[],
  args: Record<string, unknown>,
  audit?: (event: string, detail: Record<string, unknown>) => void,
): Promise<{ ok: boolean; text: string }> {
  return runSendMessageFor(cfgStore, job, allowedChannels, args, audit);
}
