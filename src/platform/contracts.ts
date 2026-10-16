import type { Range } from '../core/types.ts';

export type Capability = 'ready' | 'needs-permission' | 'revoked' | 'unavailable' | 'failed';
export type ReadingSourceInfo = { id: string; name: string; installed: boolean; tested: boolean; testedVersion: string; version: string; comments: boolean };
export type ReadingAnchor = { bookId: string; version: string; sessionId: string; generation: number; position: Range };
export type CaptureRequest = { captureToken: string; sourceId: string; anchor: ReadingAnchor };
export type SourceObservation = {
  captureToken: string;
  sourceId: string;
  observedAt: number;
  kind: 'body' | 'comment';
  text: string;
  // Only a cropped, verified single-column frame can grant its interior interval.
  // Omission keeps separate matched fragments; this never authorizes page jumps.
  coverage?: 'fragments' | 'continuous-page';
  boundary: { coordinateSpace: 'screen'; top: number; bottom: number; width: number; height: number };
};
export type VoiceRequest = { token: string; anchor: ReadingAnchor };
export type VoiceResult = { token: string; text: string; final: boolean; cancelled: boolean };
export type NativeCapabilities = {
  capture: Capability;
  sourceIdentity: Capability;
  floatingReply: Capability;
  voice: Capability;
  backgroundCore: Capability;
};

// Target contract for native hosts. Each platform reports actual capabilities;
// a compiled UI alone never implies that cross-application capture is available.
export interface ReadingHost {
  capabilities(): Promise<NativeCapabilities>;
  readingSources(): Promise<ReadingSourceInfo[]>;
  startCapture(request: CaptureRequest): Promise<void>;
  stopCapture(captureToken: string): Promise<void>;
  startVoice(request: VoiceRequest): Promise<void>;
  cancelVoice(token: string): Promise<void>;
  presentShortReply(captureToken: string, text: string): Promise<void>;
}
