import type { FactReview, ReviewedFact, FactSource } from './fact-review.ts';
import type { AgentModelRequest } from './agent-port.ts';

export type AgentReviewRequest = AgentModelRequest & {
  review: FactReview;
  lookupEvidence?(query: string): Promise<Omit<FactSource, 'id'>[]>;
  /** Persist visible original-text coordinates before the next model request. */
  checkpointSources?(sources: FactSource[]): Promise<void>;
  /** Remaining calls of the persisted item, not a fresh budget on resume. */
  remainingCalls?: number;
};
/** The runtime proposes a revision; the engine owns permission checks and durable memory writes. */
export interface AgentFactReviewer { review(input: AgentReviewRequest): Promise<ReviewedFact[]>; }
