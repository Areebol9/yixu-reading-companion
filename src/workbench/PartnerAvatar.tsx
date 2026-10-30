import { t } from './i18n.ts';
import { useEffect, useState } from 'react';
import type { WorkbenchClient } from './contract.ts';
import { Icon, type IconName } from './icons.tsx';
import { personaAvatarPresetIds } from '../core/persona-avatar-presets.ts';
import chiXiaAvatar from '../assets/partner-avatars/chi-xia-cat-20261027.png';
import songQingyueAvatar from '../assets/partner-avatars/song-qingyue-tiger-20261027.png';
import suYanAvatar from '../assets/partner-avatars/su-yan-dog-20261027.png';
import shenKeAvatar from '../assets/partner-avatars/shen-ke-peak-20261027.png';
import yuXiaoyuAvatar from '../assets/partner-avatars/yu-xiaoyu-shark-20261027.png';
import liangXiaoAvatar from '../assets/partner-avatars/liang-xiao-lemon-20261027.png';

export type AvatarChoice = { kind: 'preset'; id: string } | { kind: 'image'; assetId: string };
export const avatarPresets: readonly { id: string; label: string; icon: IconName; tone: string; image?: string }[] = [
  { id: 'leaf', get label(){return t("新叶");}, icon: 'leaf', tone: 'sage' },
  { id: 'book', get label(){return t("书页");}, icon: 'book', tone: 'sand' },
  { id: 'spark', get label(){return t("星光");}, icon: 'spark', tone: 'lilac' },
  { id: 'initial', get label(){return t("名字");}, icon: 'chat', tone: 'rose' },
  { id: personaAvatarPresetIds['chi-xia'], get label(){return t("池夏·黑猫");}, icon: 'spark', tone: 'lilac', image: chiXiaAvatar },
  { id: personaAvatarPresetIds['song-qingyue'], get label(){return t("宋清越·布老虎");}, icon: 'book', tone: 'sand', image: songQingyueAvatar },
  { id: personaAvatarPresetIds['su-yan'], get label(){return t("苏晏·小狗");}, icon: 'leaf', tone: 'sage', image: suYanAvatar },
  { id: personaAvatarPresetIds['shen-ke'], get label(){return t("沈恪·山峰");}, icon: 'chat', tone: 'sage', image: shenKeAvatar },
  { id: personaAvatarPresetIds['yu-xiaoyu'], get label(){return t("喻小鱼·鲨鱼");}, icon: 'spark', tone: 'sand', image: yuXiaoyuAvatar },
  { id: personaAvatarPresetIds['liang-xiao'], get label(){return t("梁宵·柠檬");}, icon: 'spark', tone: 'sand', image: liangXiaoAvatar },
];

export function PartnerAvatar({ client, avatar, name, size = 44 }: { client: WorkbenchClient; avatar?: AvatarChoice; name: string; size?: number }) {
  const [loaded, setLoaded] = useState<{ id: string; url: string }>();
  const assetId = avatar?.kind === 'image' ? avatar.assetId : undefined;
  useEffect(() => {
    let cancelled = false;
    if (assetId) void client.getPartnerAvatar(assetId).then(url => { if (!cancelled && url) setLoaded({ id: assetId, url }); }).catch(() => { if (!cancelled) setLoaded(undefined); });
    return () => { cancelled = true; };
  }, [client, assetId]);
  const preset = avatarPresets.find(item => item.id === (avatar?.kind === 'preset' ? avatar.id : 'leaf')) ?? avatarPresets[0];
  const imageUrl = assetId && loaded?.id === assetId ? loaded.url : preset.image;
  return <span className={`partner-avatar tone-${preset.tone}`} style={{ width: size, height: size }} aria-hidden="true">
    {imageUrl ? <img src={imageUrl} alt="" /> : preset.id === 'initial' ? <span className="partner-avatar-letter" style={{ fontSize: size * .4 }}>{Array.from(name.trim())[0] ?? t("伴")}</span> : <Icon name={preset.icon} size={Math.round(size * .48)} />}
  </span>;
}


type MessagePartner = { id: string; name: string; avatar?: AvatarChoice; legacyUnlabelled?: boolean };
/** Old unlabelled records belong only to the explicitly designated legacy owner. */
export function messagePartner(partners: readonly MessagePartner[], partnerId?: string) {
  return partnerId ? partners.find(partner => partner.id === partnerId) : partners.find(partner => partner.legacyUnlabelled);
}
export function PartnerMessageAuthor({ client, partners, partnerId }: { client: WorkbenchClient; partners: readonly MessagePartner[]; partnerId?: string }) {
  const partner = messagePartner(partners, partnerId), name = partner?.name || t("未命名伙伴");
  return <span className="message-author"><PartnerAvatar client={client} avatar={partner?.avatar} name={name} size={24} /><span>{name}</span></span>;
}
