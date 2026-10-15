import { UserFacingError } from '../../shared/errors.ts';

/** Includes the active image and every queued input; reserves no image buffers itself. */
export class ImageProcessingCapacity {
  private bytes=0;
  private count=0;
  reserve(size:number):()=>void {
    if(this.count>=8||this.bytes+size>64*1024*1024)
      throw new UserFacingError('图片本地处理繁忙，请稍后重试本地处理；原生图请求未重新发送');
    this.count++;this.bytes+=size;
    let released=false;
    return ()=>{if(!released){released=true;this.count--;this.bytes-=size;}};
  }
}
