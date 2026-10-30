import { id } from './books.ts';
import type { State, Usage } from './types.ts';

export function estimateCost(input: number, output: number, pricing?: Usage['pricing']): number | undefined {
  if (!pricing) return undefined;
  if (![input, output, pricing.input, pricing.output].every(n => Number.isFinite(n) && n >= 0)) throw new Error('用量或单价无效');
  return (input * pricing.input + output * pricing.output) / 1_000_000;
}
export function setCostLimit(state: State, limit?: number): void {
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) throw new Error('费用上限应为非负金额');
  if (!state.settings.costBudgetId && state.settings.costLimit !== undefined) {
    const budgetId = id(); state.settings.costBudgetId = budgetId;
    state.settings.costBudgetStartedAt = state.usage.reduce((earliest, usage) => Math.min(earliest, usage.time), Date.now());
    state.usage.forEach(u => { u.costBudgetId = budgetId; });
  }
  if (limit !== undefined && !state.settings.costBudgetId && state.settings.costLimit === undefined) {
    state.settings.costBudgetId = id(); state.settings.costBudgetStartedAt = Date.now();
  }
  state.settings.costLimit = limit;
}
type AccountingState = { readonly settings: Readonly<Pick<State['settings'], 'costBudgetId' | 'costLimit' | 'tokenLimit'>>; readonly usage: readonly Usage[] };
/** A local attempt fence retains the larger HTTP reservation without rewriting
 * its original core usage. Several successor calls can carry the same proof. */
export function usageTokens(usage: readonly Usage[]) {
  const held = new Map<string, number>(), originals = new Map(usage.map(item => [item.id, item]));
  for (const item of usage) {
    const audit = item.terminatedReadingContinuation, proof = audit?.localAttemptFence;
    if (!audit || !proof) continue;
    const original = originals.get(audit.unknownUsageId);
    if (!original || original.status !== 'unknown' || original.dispatchState !== 'dispatch-started' && original.dispatchState !== 'response-received' || original.requestKey !== audit.requestKey || original.coreReadingPayload?.scheme !== audit.payloadScheme || original.coreReadingPayload.hash !== audit.originalPayloadHash) continue;
    try {
      const certificate = JSON.parse(audit.terminationEvidence), payload = JSON.parse(audit.payloadEvidence), reservation = certificate.originalCoreReservation, hold = certificate.holdReservation;
      const closed = Date.parse(proof.closedAt);
      if (![proof.cohortId, proof.protocolSHA, proof.fenceSHA].every(value => /^[a-f0-9]{64}$/.test(value)) || !Number.isFinite(closed) || closed < original.time || new Date(closed).toISOString() !== proof.closedAt || certificate.schema !== 'local-reading-attempt-fence/v1' || certificate.requestId !== original.id || certificate.serviceId !== original.serviceId || certificate.providerOutcome !== 'unknown' || certificate.inputHash !== audit.originalPayloadHash || certificate.cohortId !== proof.cohortId || certificate.protocolSHA !== proof.protocolSHA || certificate.closedAt !== proof.closedAt || payload.requestId !== original.id || payload.serviceId !== original.serviceId || payload.inputHash !== audit.originalPayloadHash || certificate.payloadSHA !== payload.payloadSHA || !/^[a-f0-9]{64}$/.test(certificate.payloadSHA) || !reservation || reservation.inputTokens !== original.input || reservation.outputTokens !== original.output || reservation.totalTokens !== original.input + original.output || !hold || ![hold.inputTokens, hold.outputTokens, hold.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0) || hold.totalTokens !== hold.inputTokens + hold.outputTokens || hold.inputTokens < reservation.inputTokens || hold.outputTokens < reservation.outputTokens) continue;
      held.set(original.id, Math.max(held.get(original.id) ?? 0, hold.totalTokens));
    } catch { /* Unusable historical evidence cannot change the accounting. */ }
  }
  let actualTokens = 0, reservedTokens = 0;
  for (const item of usage) {
    const amount = Math.max(item.input + item.output, held.get(item.id) ?? 0);
    if (item.estimated || item.status === 'reserved' || item.status === 'unknown') reservedTokens += amount;
    else actualTokens += amount;
  }
  return {actualTokens, reservedTokens, tokens: actualTokens + reservedTokens};
}
export function budgetUsage(state: AccountingState): readonly Usage[] {
  const budgetId = state.settings.costBudgetId;
  return budgetId ? state.usage.filter(u => u.costBudgetId === budgetId) : state.usage;
}
export function accounting(state: AccountingState) {
  const items = budgetUsage(state), {tokens} = usageTokens(state.usage);
  const cost = items.reduce((n, u) => n + (u.cost ?? 0), 0), unknown = items.filter(u => u.cost === undefined).length;
  const allCost = state.usage.reduce((n, u) => n + (u.cost ?? 0), 0), allUnknown = state.usage.filter(u => u.cost === undefined).length;
  const level = (used: number, limit: number | undefined) => limit === undefined ? 0 : used >= limit ? 2 : used >= limit * .8 ? 1 : 0;
  return { tokens, cost, unknown, allCost, allUnknown, tokenLevel: level(tokens, state.settings.tokenLimit), costLevel: level(cost, state.settings.costLimit) };
}
