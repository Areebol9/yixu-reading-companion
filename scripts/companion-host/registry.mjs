import {createCompanionCoordinator} from './coordinator.mjs';
const roots = new Map();
export function companionCoordinator(root) { let item = roots.get(root); if (!item) { item = createCompanionCoordinator(root); roots.set(root, item); } return item; }
