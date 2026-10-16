// Apply only a saved edit's changes to the current in-memory state. Other events
// may have appended questions or advanced progress while the store was writing.
export function mergeStateEdit<T>(before: T, after: T, current: T): T {
  if (before === after) return current;
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    const identified = [...before, ...after, ...current].every((item: unknown) => item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string');
    if (identified) {
      const previous = new Map(before.map(item => [item.id, item]));
      const saved = new Map(after.map(item => [item.id, item]));
      const present = new Set(current.map(item => item.id));
      const result = current.filter(item => !previous.has(item.id) || saved.has(item.id)).map(item => previous.has(item.id) && saved.has(item.id) ? mergeStateEdit(previous.get(item.id), saved.get(item.id), item) : item);
      for (const item of after) if (!previous.has(item.id) && !present.has(item.id)) result.push(item);
      return result as T;
    }
    return (JSON.stringify(before) === JSON.stringify(after) ? current : after) as T;
  }
  if (before && after && current && typeof before === 'object' && typeof after === 'object' && typeof current === 'object') {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>, live = current as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in right)) { if (key in left) delete live[key]; }
      else if (!(key in left)) live[key] = right[key];
      else live[key] = mergeStateEdit(left[key], right[key], live[key]);
    }
    return current;
  }
  return after;
}
