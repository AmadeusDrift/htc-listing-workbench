import { UserFacingError } from '../../shared/errors.ts';
/** Only raised by the last synchronous scope guard, before transport sends a PUT. */
export class TaskWriteNotSentError extends UserFacingError {
  constructor() { super('任务范围已暂停或变化；此次提交尚未发出，请核对后重新预览'); }
}
