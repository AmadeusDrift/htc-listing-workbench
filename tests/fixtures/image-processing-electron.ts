import { app,nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeArtifactInBackground,decodePreviewInBackground,closeImageProcessing } from '../../src/main/image-processing/client.ts';
import { artifactPixels,previewPixels } from '../../src/main/image-processing/pixels.ts';
app.setPath('userData',join(__dirname,'parent-profile'));
app.whenReady().then(async()=>{
  try {
    const bitmap=Buffer.alloc(1280*960*4,255);for(let i=3;i<bitmap.length;i+=8)bitmap[i]=0;
    const bytes=nativeImage.createFromBitmap(bitmap,{width:1280,height:960}).toPNG();
    const expectedPreview=previewPixels(bytes),expectedArtifact=artifactPixels(bytes);
    let ticks=0;const interval=setInterval(()=>ticks++,1),started=performance.now();
    const [preview,artifact]=await Promise.all([decodePreviewInBackground(bytes),decodeArtifactInBackground(bytes)]);
    clearInterval(interval);
    assert.deepEqual(preview,expectedPreview);assert.deepEqual(artifact,expectedArtifact);assert.ok(ticks>3);
    assert.equal(artifact.transparentPixels,1280*960/2);assert.equal(artifact.subjectPixels,1280*960/2);
    await assert.rejects(decodePreviewInBackground(Buffer.from('invalid image')));
    assert.deepEqual(await decodePreviewInBackground(bytes),expectedPreview);
    await closeImageProcessing();await assert.rejects(decodePreviewInBackground(bytes));
    console.log(JSON.stringify({ok:true,parentPid:process.pid,width:artifact.width,height:artifact.height,transparentPixels:artifact.transparentPixels,previewSha256:createHash('sha256').update(preview).digest('hex'),parentTicks:ticks,ms:performance.now()-started}));
    app.exit(0);
  }catch(error){console.error(error);await closeImageProcessing();app.exit(1);}
});
