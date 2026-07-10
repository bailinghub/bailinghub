import type { RuntimeContext } from './context';

export interface StoreFactory<ConfigStoreT, StateStoreT> {
  config(ctx: RuntimeContext): ConfigStoreT;
  state(ctx: RuntimeContext): StateStoreT;
}
