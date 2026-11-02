import { EventEmitter } from 'node:events';
import { currentProjectId } from './context.js';

export type StudioEvent = {
  type:
    | 'collection' | 'document' | 'file' | 'function' | 'execution' | 'site'
    | 'user' | 'message' | 'ai' | 'log'
    | 'project' | 'member' | 'domain' | 'schedule' | 'git';
  action: string;
  resource?: string;
  detail?: string;
  /** Owning project — webhooks need it to fan out to the right subscriptions. */
  projectId?: string;
  at: string;
};

class Bus extends EventEmitter {
  publish(e: Omit<StudioEvent, 'at'>) {
    this.emit('event', {
      ...e,
      projectId: e.projectId || currentProjectId(),
      at: new Date().toISOString(),
    } satisfies StudioEvent);
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);
