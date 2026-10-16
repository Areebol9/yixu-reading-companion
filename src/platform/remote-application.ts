import { freezeData } from '../core/application-contract.ts';
import type { ApplicationClient, ApplicationCommand, ApplicationSnapshot, CommandArgs, CommandResult } from '../core/application-contract.ts';
import type { ApplicationFrame, ApplicationRequest, ApplicationResult } from '../core/application-wire.ts';
import type { RuntimeUIEvent } from '../core/runtime.ts';

export class RemoteApplication implements ApplicationClient {
  private current: ApplicationFrame;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private consumed = 0;
  private events: ApplicationFrame['events'] = [];
  private localEvents: RuntimeUIEvent[] = [];
  private send: (request: ApplicationRequest) => void;
  private ack: (epoch: string, sequence: number) => void;
  constructor(frame: ApplicationFrame, send: RemoteApplication['send'], ack: RemoteApplication['ack']) {
    this.current = freezeData(frame) as ApplicationFrame; this.send = send; this.ack = ack; this.events = [...frame.events];
  }
  get snapshot(): ApplicationSnapshot { return this.current.snapshot; }
  receive(frame: ApplicationFrame) {
    if (frame.epoch !== this.current.epoch) { this.fail('运行核心已重启，未完成操作请根据当前记录手动接续'); this.consumed = 0; this.events = []; }
    else if (frame.snapshot.revision < this.current.snapshot.revision) return;
    this.current = freezeData(frame) as ApplicationFrame;
    const seen = new Set(this.events.map(e => e.sequence));
    this.events.push(...frame.events.filter(e => e.sequence > this.consumed && !seen.has(e.sequence)));
    this.listeners.forEach(fn => fn());
  }
  result(value: ApplicationResult) {
    if (value.epoch !== this.current.epoch) return;
    const job = this.pending.get(value.id); if (!job) return; this.pending.delete(value.id);
    if (value.error) { const error = new Error(value.error); error.name = value.errorName ?? 'Error'; job.reject(error); } else job.resolve(value.value);
  }
  fail(message: string) { for (const job of this.pending.values()) job.reject(new Error(message)); this.pending.clear(); this.localEvents.push({ kind: 'error', text: message }); this.listeners.forEach(fn => fn()); }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  takeUIEvents(): RuntimeUIEvent[] {
    const pending = this.events.splice(0); if (pending.length) { this.consumed = Math.max(this.consumed, ...pending.map(e => e.sequence)); this.ack(this.current.epoch, this.consumed); }
    return [...this.localEvents.splice(0), ...pending.map(e => e.value)];
  }
  command<K extends ApplicationCommand>(name: K, ...args: CommandArgs<K>): Promise<CommandResult<K>> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as CommandResult<K>), reject });
      try { this.send({ id, epoch: this.current.epoch, name, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
}
