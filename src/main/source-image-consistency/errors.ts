import { UserFacingError } from '../../shared/errors.ts';

export class SourceConsistencyError extends UserFacingError {
  readonly kind:'NEEDS_INPUT'|'SYSTEM_REPAIR'|'UNKNOWN';readonly code:string;
  constructor(kind:'NEEDS_INPUT'|'SYSTEM_REPAIR'|'UNKNOWN',code:string,message:string){super(message);this.kind=kind;this.code=code;}
}
