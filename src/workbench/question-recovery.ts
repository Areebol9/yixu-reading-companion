import type {ApplicationSnapshot} from '../core/application-contract.ts';
import {availableRecovery} from './activity-presentation.ts';

/** Paragraph questions and chat questions consume the same core decisions. */
export function questionRecoveryOptions(app:ApplicationSnapshot,questionId:string){
  return app.activities.map(availableRecovery).filter(decision=>decision?.target?.kind==='question'&&decision.target.questionId===questionId);
}

