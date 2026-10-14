export interface PackRecord {
  files: Array<{ path: string }>;
}

export function readPackRecord(result: unknown): PackRecord;
