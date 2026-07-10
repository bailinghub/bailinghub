// OSS 默认渠道出站包装：这里才绑定 app/runtime 单组织单例。
// 自定义部署应使用 channels.ts 的 channelSendFor(config, ...)。
import { cfgStore } from './runtime';
import { channelSendFor, type ChannelMessage, type ChannelSendResult } from './channels';

export async function channelSend(channelName: string, recipient: string, message: string | ChannelMessage): Promise<ChannelSendResult> {
  return channelSendFor(cfgStore, channelName, recipient, message);
}
