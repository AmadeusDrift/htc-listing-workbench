export type WorkspaceLane = 'inbox' | 'manual' | 'automatic' | 'ignored';

export interface WorkspacePlacement {
  productId: string;
  lane: WorkspaceLane;
  updatedAt: string;
}

export interface MoveWorkspaceProducts {
  productIds: string[];
  destination: WorkspaceLane;
}

export interface WorkspaceApi {
  listWorkspacePlacements(): Promise<WorkspacePlacement[]>;
  /** Returns requested products in request order. Moving within the same lane is a no-op. */
  moveWorkspaceProducts(input: MoveWorkspaceProducts): Promise<WorkspacePlacement[]>;
}
