import { applicationCommands } from './application-contract.ts';
import {parseWorkDossierRequest} from './work-dossier.ts';
import type { ApplicationClient, ApplicationCommand, ApplicationSnapshot } from './application-contract.ts';
import type { RuntimeUIEvent } from './runtime.ts';

export type ApplicationFrame = { epoch: string; snapshot: ApplicationSnapshot; events: { sequence: number; value: RuntimeUIEvent }[] };
export type ApplicationResult = { id: string; epoch: string; value?: unknown; error?: string; errorName?: string };
export type ApplicationRequest = { id: string; epoch: string; name: ApplicationCommand; args: unknown[] };

function sameArguments(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameArguments(a[key], b[key]));
}

// Commands are user actions, never model tools. Validate the transport boundary
// before invoking an action; authority/range checks still execute inside the core.
export function validateCommand(value: unknown): asserts value is ApplicationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应用操作格式无效');
  const r = value as ApplicationRequest;
  if (typeof r.id !== 'string' || !/^[a-z0-9-]{8,100}$/i.test(r.id) || typeof r.epoch !== 'string' || !applicationCommands.includes(r.name) || !Array.isArray(r.args) || r.args.length > 5) throw new Error('应用操作无效');
  const descriptors: Record<ApplicationCommand, string> = {
    importText: 'ss', selectBook: 's', readBookRange:'so', setArchived: 'sb', setKnown: 'snN', confirmLocatedPosition: 'ss', setFrontMatterIncluded: 'sb', locatePosition: 'ss', startReading: 's', setReadingMode: 'ss', prepare: 's', prepareBackground: 's', finishReading: 's',
    pause: '', stop: '', pauseReadingSafely:'',resumeReadingSafely:'',stopReadingSafely:'',quiet: 'b', newDiscussion: 's', renameConversation: 'ss', listParagraphComments:'sO',postParagraphComment:'so',resumeSceneParticipation:'s',setParagraphCommentLiked:'ssb',requestParagraphReply:'ss',askAboutParagraphComment:'sss',ask: 'ssBS', askWithFuture: 'ssobS', expandReply: 's', retryQuestion: 's', recoverQuestionReceipt:'s',resumeTerminatedMaintenance:'o',resumeMaintenance:'s', correctTranscript: 'ss', correctMemory: 'ss', reviewFacts: 's', reviewFact: 's', resumeFactReview: 's', cancelFactReview: 's', forgetMemory: 's', deleteChat: 's', setCommonHabit: 'sS', updatePartner: 'sss',
    addService: '', selectService: 's', updateService: 'so', enableService: 'ss', updateLimits: 'o', selectSearch: 's', setSearchEndpoint: 's', enableSearch: 's', disableSearch: '', setWebResult: 'S', startCapture: 'ss', stopCapture: '', selectReadingSource: 'ss', startOrSendVoice: 'sS', cancelVoice: '', previewBackup: 's', restoreBackup: 'sb', exportBackup: 'b', readWorkDossier:'sO', readMemoryBody:'ss',discoverKnowledgeDocuments:'sO',
  };
  const shape = descriptors[r.name]; if (r.args.length > shape.length) throw new Error('操作参数过多');
  for (let i = 0; i < shape.length; i++) {
    const type = shape[i], item = r.args[i];
    if (item == null && type === type.toUpperCase()) { r.args[i] = undefined; continue; }
    const valid = type.toLowerCase() === 's' ? typeof item === 'string' : type.toLowerCase() === 'b' ? typeof item === 'boolean' : type.toLowerCase() === 'n' ? typeof item === 'number' && Number.isFinite(item) : item !== null && typeof item === 'object' && !Array.isArray(item);
    if (!valid) throw new Error('操作参数类型无效');
  }
  if(r.name==='readWorkDossier')parseWorkDossierRequest(r.args[1]);
}

export class ApplicationServer {
  readonly epoch = crypto.randomUUID();
  private app: ApplicationClient;
  private send: (kind: 'frame' | 'result', value: ApplicationFrame | ApplicationResult) => void;
  private records = new Map<string, { name: ApplicationCommand; args?: unknown[]; task: Promise<ApplicationResult>; pending: boolean }>();
  private events: ApplicationFrame['events'] = [];
  private sequence = 0;
  private scheduled = false;
  constructor(app: ApplicationClient, send: ApplicationServer['send']) {
    this.app = app; this.send = send;
    app.subscribe(() => { if (this.scheduled) return; this.scheduled = true; setTimeout(() => { this.scheduled = false; this.publish(); }, 0); });
  }
  frame(): ApplicationFrame {
    this.events.push(...this.app.takeUIEvents().map(value => ({ sequence: ++this.sequence, value })));
    const snapshot = this.app.snapshot;
    this.events = this.events.filter(({ value }) => value.kind !== 'openConversation' || snapshot.session?.active && value.bookId === snapshot.session.bookId && value.sessionId === snapshot.session.id && value.generation === snapshot.session.generation);
    return { epoch: this.epoch, snapshot, events: [...this.events] };
  }
  publish() { this.send('frame', this.frame()); }
  acknowledge(epoch: string, sequence: number) {
    if (epoch === this.epoch && Number.isSafeInteger(sequence)) { this.events = this.events.filter(event => event.sequence > sequence); this.publish(); }
  }
  async receive(request: unknown): Promise<void> {
    const id = (request as ApplicationRequest)?.id;
    try {
      validateCommand(request);
      if (request.epoch !== this.epoch) throw new Error('运行核心已重新启动，请查看最新记录后再操作');
      const discardReceipt = request.args.some(arg => typeof arg === 'string' && arg.length > 32000) || ['exportBackup','enableService','enableSearch','restoreBackup','readWorkDossier','readMemoryBody','resumeTerminatedMaintenance'].includes(request.name);
      let record = this.records.get(id);
      if (record && (record.name !== request.name || record.args && !sameArguments(record.args, request.args))) throw new Error('同一操作标识不能用于不同请求');
      if (!record) {
        if ([...this.records.values()].filter(r => r.pending).length >= 64) throw new Error('待处理操作过多，请稍后再试');
        // Save the receipt before execution so a repeated delivery joins the same work.
        // Hold argument references while pending; a JSON signature would duplicate full novels.
        record = { name: request.name, args: request.args, pending: true, task: Promise.resolve({ id, epoch: this.epoch }) };
        this.records.set(id, record);
        record.task = Promise.resolve().then(() => this.app.command(request.name, ...request.args as never)).then(
          value => ({ id, epoch: this.epoch, value }),
          error => ({ id, epoch: this.epoch, error: String(error?.message ?? error), errorName: error?.name }),
        );
      }
      const result = await record.task;
      record.pending = false;
      this.publish(); this.send('result', result);
      // Large exports and credentials are not retained in the receipt cache.
      if (discardReceipt) {
        record.args = undefined; record.task = Promise.resolve({ id, epoch: this.epoch, error: '此操作已完成，请查看当前记录；不会自动重复执行' });
      }
      for (const [key, value] of this.records) { if (this.records.size <= 128) break; if (!value.pending) this.records.delete(key); }
    } catch (error) {
      this.send('result', { id, epoch: this.epoch, error: String((error as Error).message), errorName: (error as Error).name });
    }
  }
}
