import assert from 'node:assert/strict';

/** Two ordinary live requests; only a real explicit response may use slot 3. */
export const PC_DISPATCH_POLICY=Object.freeze({ordinary:2,explicitResponse:3});
export function dispatchRole(value){
 assert(value===undefined||value==='ordinary'||value==='explicit-response','Unknown model dispatch role');
 return value??'ordinary';
}
export function canAdmitDispatch(liveRoles,role,policy=PC_DISPATCH_POLICY){
 assert.deepEqual(policy,PC_DISPATCH_POLICY,'Unsupported PC dispatch policy');
 const next=dispatchRole(role),ordinary=liveRoles.filter(value=>dispatchRole(value)==='ordinary').length;
 return liveRoles.length<policy.explicitResponse&&(next==='explicit-response'||ordinary<policy.ordinary);
}
