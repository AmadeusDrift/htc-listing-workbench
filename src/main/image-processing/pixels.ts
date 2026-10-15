import { nativeImage } from 'electron';
import { UserFacingError } from '../../shared/errors.ts';
import { inspectRaster } from '../image-format.ts';
import type { DecodedArtifact } from '../image-versions/service.ts';

/** Original CPU operations, executed only inside the isolated image process. */
export function previewPixels(bytes:Buffer):Buffer {
  const image=nativeImage.createFromBuffer(bytes);
  if(image.isEmpty())throw new UserFacingError('图片无法解码，请检查文件是否损坏');
  const {width,height}=image.getSize(),scale=Math.min(1,640/Math.max(width,height));
  return image.resize({width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale)),quality:'good'}).toPNG();
}
export function artifactPixels(bytes:Buffer):DecodedArtifact {
  const raster=inspectRaster(bytes);
  if(raster.mimeType!=='image/png'||raster.width>3000||raster.height>3000)throw new UserFacingError('抠图成果需要为原尺寸 PNG');
  const decoded=nativeImage.createFromBuffer(bytes),size=decoded.getSize();
  if(decoded.isEmpty()||size.width!==raster.width||size.height!==raster.height)throw new UserFacingError('图片成果无法完整解码');
  const bitmap=decoded.toBitmap();
  if(bitmap.length!==size.width*size.height*4)throw new UserFacingError('图片成果像素格式无效');
  let transparentPixels=0;
  for(let offset=3;offset<bitmap.length;offset+=4)if(bitmap[offset]===0)transparentPixels++;
  const scale=Math.min(1,640/Math.max(size.width,size.height));
  const preview=decoded.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'good'}).toPNG();
  return {...size,transparentPixels,subjectPixels:size.width*size.height-transparentPixels,preview};
}
