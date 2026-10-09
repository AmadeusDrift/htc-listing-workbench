export interface ShipmentDocument {
  id: string; batchId: string; shipmentId: string; fileName: string; relativePath: string;
  sha256: string; byteSize: number; createdAt: string; status: 'LINKED_UNVERIFIED';
}
export interface ShipmentDocumentApi {
  listProcurementShipmentDocuments(batchId: string): Promise<ShipmentDocument[]>;
  importProcurementShipmentDocument(batchId: string): Promise<ShipmentDocument | null>;
  openProcurementShipmentDocument(id: string): Promise<void>;
}
