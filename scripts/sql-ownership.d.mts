export interface SqlWrite { operation:string; table:string }
export interface SqlEntry {file:string;command:string;line:number;sql:string;writes:SqlWrite[]}
export interface OpaqueEntry {file:string;command:string;line:number;expression:string}
export interface TableSet {file:string;name:string;tables:string[]}
export interface SqlInventory {writes:SqlEntry[];opaque:OpaqueEntry[];tableSets?:TableSet[]}
export interface WriterRegistry {tableSets?:TableSet[];writers:Record<string,{commands:string[];statements?:Record<string,number>}>;opaque:Omit<OpaqueEntry,'line'>[]}
export function sqlWrites(sql:string):SqlWrite[];
export function scanSql(file:string,source:string):SqlInventory;
export function ownershipViolations(inventory:SqlInventory,registry:WriterRegistry,ownerFor:(table:string)=>unknown):string[];
