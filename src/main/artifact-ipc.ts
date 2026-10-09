import type { IpcHandler } from './amazon-ipc.ts';
import type { ImageVersionService } from './image-versions/service.ts';
import type { ReviewedContentService } from './content/service.ts';
import { identifier } from '../shared/validation.ts';

export function installArtifactIpc(images: ImageVersionService, content: ReviewedContentService, handle: IpcHandler): void {
  handle('red:images:save-result', 1, raw => images.save(raw));
  handle('red:images:versions', 1, raw => images.list(identifier(raw)));
  handle('red:images:select-version', 1, raw => images.select(raw));
  handle('red:images:selections', 1, raw => images.selections(identifier(raw)));
  handle('red:images:version-preview', 1, raw => images.preview(identifier(raw)));
  handle('red:content:adopt', 1, raw => content.adopt(raw));
  handle('red:content:versions', 1, raw => content.list(identifier(raw)));
  handle('red:images:versions-query', 1, raw => images.queryVersions(raw));
  handle('red:images:selections-query', 1, raw => images.querySelections(raw));
  handle('red:content:versions-query', 1, raw => content.queryVersions(raw));
}
