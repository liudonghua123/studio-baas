import { EventEmitter } from 'node:events';

export type StudioEvent = {
  type:
    | 'collection' | 'document' | 'file' | 'function' | 'execution' | 'site'
    | 'user' | 'message' | 'ai' | 'log'
    | 'project' | 'member' | 'domain' | 'schedule' | 'git';
  action: string;
  resource?: string;
  detail?: string;
  at: string;
};

class Bus extends EventEmitter {
  publish(e: Omit<StudioEvent, 'at'>) {
    this.emit('event', { ...e, at: new Date().toISOString() } satisfies StudioEvent);
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);
