import { UserFacingError } from '../shared/errors.ts';
export interface RasterInfo { mimeType: string; extension: 'png' | 'jpg'; width: number; height: number }
export function inspectRaster(data: Buffer): RasterInfo {
  let width = 0, height = 0, extension: RasterInfo['extension'] = 'png';
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && data.toString('ascii', 12, 16) === 'IHDR') {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    extension = 'jpg';
    let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else { throw new UserFacingError('只支持有效的 PNG / JPEG 图片，请先转换格式'); }
  if (!width || !height || width > 15000 || height > 15000 || width * height > 40_000_000) throw new UserFacingError('图片尺寸无效或超过 4000 万像素，请先缩小图片');
  return { mimeType: extension === 'png' ? 'image/png' : 'image/jpeg', extension, width, height };
}
