/** Adoption preserves source history as evidence, never as target review authority. */
export interface FoldyImportPreflight {
  version: 'foldy-import-adoption.v1';
  projectId: string;
  expectedCurrentRevisionId: null;
  metadataSha256: string;
  importedRootSha256: string;
  rootFiles: Array<{ path: string; sha256: string }>;
  snapshotKind: 'imported-html-snapshot';
}
export interface AdoptFoldyImportRequest extends FoldyImportPreflight {
  confirmExactContent: true;
}
