import { restoreBackup } from './backup.ts';
import { recoverInterruptedState } from './startup.ts';
import { initialState } from './state.ts';
import type { State } from './types.ts';

// A one-time storage migration preserves the user's selected services and reading
// resume target. It is not a backup import and never grants fresh work on startup.
export async function validateMigration(value: State | null) {
  if (!value) return { state: initialState(), recovery: { changed: false, questions: 0, temporaryQuestions: 0, unknownCalls: 0 } };
  const source = structuredClone(value);
  const state = await restoreBackup(JSON.stringify(source), initialState());
  for (const service of state.settings.services) service.enabled = source.settings.services.find(s => s.id === service.id)?.enabled === true;
  state.settings.searchEnabled = source.settings.searchEnabled === true;
  state.resume = source.resume;
  const recovery = recoverInterruptedState(source);
  recoverInterruptedState(state);
  return { state, recovery };
}
