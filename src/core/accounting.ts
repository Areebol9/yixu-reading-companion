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
export function budgetUsage(state: AccountingState): readonly Usage[] {
  const budgetId = state.settings.costBudgetId;
  return budgetId ? state.usage.filter(u => u.costBudgetId === budgetId) : state.usage;
}
export function accounting(state: AccountingState) {
  const items = budgetUsage(state), tokens = state.usage.reduce((n, u) => n + u.input + u.output, 0);
  const cost = items.reduce((n, u) => n + (u.cost ?? 0), 0), unknown = items.filter(u => u.cost === undefined).length;
  const allCost = state.usage.reduce((n, u) => n + (u.cost ?? 0), 0), allUnknown = state.usage.filter(u => u.cost === undefined).length;
  const level = (used: number, limit: number | undefined) => limit === undefined ? 0 : used >= limit ? 2 : used >= limit * .8 ? 1 : 0;
  return { tokens, cost, unknown, allCost, allUnknown, tokenLevel: level(tokens, state.settings.tokenLimit), costLevel: level(cost, state.settings.costLimit) };
}
