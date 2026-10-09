export const SKU_NAMING_TABLES: Record<string, string[]> = {
  sku_naming_sequences: ['store_scope', 'collection_date', 'last_sequence'],
  sku_naming_groups: ['id', 'store_scope', 'source_group_key', 'collection_date', 'sequence', 'record_json'],
  sku_naming_identities: ['store_scope', 'sku', 'group_id', 'child_key', 'child_index'],
};
// These canonical declarations also let backup validation reject weakened uniqueness constraints.
export const SKU_NAMING_SCHEMA = [
  `CREATE TABLE sku_naming_sequences (
    store_scope TEXT NOT NULL, collection_date TEXT NOT NULL, last_sequence INTEGER NOT NULL CHECK(last_sequence BETWEEN 1 AND 999999999),
    PRIMARY KEY(store_scope,collection_date)
  )`,
  `CREATE TABLE sku_naming_groups (
    id TEXT PRIMARY KEY NOT NULL, store_scope TEXT NOT NULL, source_group_key TEXT NOT NULL,
    collection_date TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 999999999), record_json TEXT NOT NULL,
    UNIQUE(store_scope,source_group_key), UNIQUE(store_scope,collection_date,sequence)
  )`,
  `CREATE TABLE sku_naming_identities (
    store_scope TEXT NOT NULL, sku TEXT NOT NULL COLLATE NOCASE,
    group_id TEXT NOT NULL REFERENCES sku_naming_groups(id) ON DELETE RESTRICT,
    child_key TEXT NOT NULL, child_index INTEGER NOT NULL CHECK(child_index BETWEEN 0 AND 4096),
    PRIMARY KEY(store_scope,sku), UNIQUE(group_id,child_key), UNIQUE(group_id,child_index)
  )`,
] as const;
