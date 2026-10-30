import {hashText} from './text-hash.ts';
import type {PartnerAvatarAsset} from './types.ts';

export async function partnerAvatarAsset(dataUrl:string):Promise<PartnerAvatarAsset>{
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if(!match||dataUrl.length>2_000_000)throw Error('请选择PNG、JPEG或WebP图片，并裁剪后保存');
  const bytes=Uint8Array.from(atob(match[2]),value=>value.charCodeAt(0));
  const valid=match[1]==='image/png'?bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71
    :match[1]==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255
    :String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if(!valid)throw Error('头像图片内容无法识别，请重新选择图片');
  return{id:'avatar-'+await hashText(dataUrl),mimeType:match[1] as PartnerAvatarAsset['mimeType'],dataUrl,createdAt:Date.now()};
}
