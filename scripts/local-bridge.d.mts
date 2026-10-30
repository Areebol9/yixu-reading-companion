import type {Server} from 'node:http';
export function createLocalBridge(options?: {port?: number; workspaceRoot?: string; distRoot?:string;defaultDocument?:string; fetchImpl?: typeof fetch; logger?: (...values: unknown[]) => void}): Server;
