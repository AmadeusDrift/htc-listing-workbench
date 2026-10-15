export interface AutomaticItemDiagnostic {
 resultUnknown:boolean;
 fields:{name:string;message:string;hasSavedValue:boolean|null}[];
 requests:{id:string;purpose:string;status:string;errorCode:string|null;startedAt:string|null;finishedAt:string|null;fields:string[]}[];
 note:string;
}
