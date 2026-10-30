import type {State,Store} from './types.ts';

export type VerifiedContentTransfer={manifestHash:string;store:Pick<Store,'readTaskMaterials'|'readMemoryBodies'|'readPartnerAvatar'>};
const transfers=new WeakMap<object,VerifiedContentTransfer>();
/** Host injects a read-only resolver only after its isolated object table and
 * manifest have passed verification. JSON/RPC cannot forge this process identity. */
export function bindVerifiedContentTransfer(state:State,transfer:VerifiedContentTransfer){
  if(!/^[a-f0-9]{64}$/.test(transfer.manifestHash)||!transfer.store.readTaskMaterials)throw Error('Verified portable resolver is invalid');
  transfers.set(state,Object.freeze({...transfer,store:Object.freeze({...transfer.store})}));
}
export function verifiedContentTransfer(value:unknown){return value&&typeof value==='object'?transfers.get(value):undefined;}
