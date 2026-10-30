import { t } from './i18n.ts';
export type AvatarImage = { image: HTMLImageElement; url: string; width: number; height: number };
export type AvatarCrop = { zoom: number; x: number; y: number };
export const initialAvatarCrop: AvatarCrop = { zoom: 1, x: 50, y: 50 };

export async function loadAvatarImage(file: File): Promise<AvatarImage> {
  if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(file.type)) throw Error(t("请选择 PNG、JPG、WebP 等图片文件。"));
  if (file.size > 12 * 1024 * 1024) throw Error(t("请选用小于 12 MB 的图片。"));
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(Error(t("这张图片无法打开，请换一张图片。"))); image.src = url; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw Error(t("图片尺寸过大，请缩小后重新选择。"));
    return { image, url, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export function avatarCropBox(source: AvatarImage, crop: AvatarCrop, size: number) {
  const scale = Math.max(size / source.width, size / source.height) * crop.zoom;
  const width = source.width * scale, height = source.height * scale;
  return { width, height, left: -(width - size) * crop.x / 100, top: -(height - size) * crop.y / 100 };
}

export function cropAvatar(source: AvatarImage, crop: AvatarCrop): string {
  const size = 320, canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw Error(t("图片裁剪暂时不可用，请重新打开伙伴页面。"));
  const box = avatarCropBox(source, crop, size);
  context.drawImage(source.image, box.left, box.top, box.width, box.height);
  return canvas.toDataURL('image/png');
}
