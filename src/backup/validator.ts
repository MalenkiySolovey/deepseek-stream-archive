import { decompressGzip } from './compression';
import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  INCLUDED_BACKUP_STORES,
  type IncludedBackupStoreName,
  type PortableBackupStoreCounts,
  type PortableBackupManifestRecord,
  type PortableBackupFooterRecord,
  type PortableBackupStoreRecord,
} from './format';

export interface BackupValidationError {
  code: string;
  message: string;
  lineIndex?: number;
}

export interface BackupValidationResult {
  valid: boolean;
  format?: string;
  formatVersion?: number;
  createdAt?: number;
  appVersion?: string;
  sourceDatabaseVersion?: number;
  counts?: PortableBackupStoreCounts;
  totalRecords?: number;
  errors: BackupValidationError[];
}

/**
 * Compare two primary keys deterministically.
 */
function compareKeys(a: unknown, b: unknown): number {
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  if (strA < strB) return -1;
  if (strA > strB) return 1;
  return 0;
}

/**
 * Pure, read-only validator for portable backup archives (.streamarchive.jsonl.gz).
 * Does NOT write to IndexedDB.
 */
export async function validatePortableBackup(
  input: ArrayBuffer | Uint8Array | Blob
): Promise<BackupValidationResult> {
  const errors: BackupValidationError[] = [];

  // 1. Convert input to Uint8Array
  let bytes: Uint8Array;
  if (input instanceof Blob) {
    const arrayBuffer = await input.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }

  // 2. Decompress gzip
  let decompressed: Uint8Array;
  try {
    decompressed = await decompressGzip(bytes);
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          code: 'corrupt_gzip_stream',
          message: `Gzip decompression failed: ${(err as Error).message}`,
        },
      ],
    };
  }

  // 3. Decode UTF-8 and split lines
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          code: 'invalid_utf8_encoding',
          message: `UTF-8 decoding failed: ${(err as Error).message}`,
        },
      ],
    };
  }

  const rawLines = text.split(/\r?\n/);
  // Remove single trailing empty line produced by the final newline
  const lastLine = rawLines[rawLines.length - 1];
  if (rawLines.length > 0 && lastLine !== undefined && lastLine.trim() === '') {
    rawLines.pop();
  }

  if (rawLines.length === 0 || !rawLines[0]) {
    return {
      valid: false,
      errors: [
        {
          code: 'empty_backup_file',
          message: 'The decompressed backup file contains zero lines.',
        },
      ],
    };
  }

  // 4. Validate Line 0 (Manifest)
  let manifest: PortableBackupManifestRecord;
  try {
    manifest = JSON.parse(rawLines[0]!);
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          code: 'malformed_json_line',
          message: `Manifest line is not valid JSON: ${(err as Error).message}`,
          lineIndex: 0,
        },
      ],
    };
  }

  if (manifest.kind !== 'manifest') {
    errors.push({
      code: 'missing_manifest',
      message: `First line must have kind="manifest", found "${manifest.kind}"`,
      lineIndex: 0,
    });
  }

  if (manifest.format !== PORTABLE_BACKUP_FORMAT) {
    errors.push({
      code: 'invalid_backup_format',
      message: `Unknown backup format: "${manifest.format}". Expected "${PORTABLE_BACKUP_FORMAT}".`,
      lineIndex: 0,
    });
  }

  if (typeof manifest.formatVersion === 'number' && manifest.formatVersion > PORTABLE_BACKUP_FORMAT_VERSION) {
    return {
      valid: false,
      format: manifest.format,
      formatVersion: manifest.formatVersion,
      errors: [
        {
          code: 'unsupported_backup_version',
          message: `Backup format version ${manifest.formatVersion} is newer than supported version ${PORTABLE_BACKUP_FORMAT_VERSION}.`,
          lineIndex: 0,
        },
      ],
    };
  }

  if (manifest.formatVersion !== PORTABLE_BACKUP_FORMAT_VERSION) {
    errors.push({
      code: 'invalid_format_version',
      message: `Unsupported formatVersion: ${manifest.formatVersion}`,
      lineIndex: 0,
    });
  }

  // 5. Track records and store transitions
  const observedCounts: PortableBackupStoreCounts = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };

  const validStoresSet = new Set<string>(INCLUDED_BACKUP_STORES);
  let currentStoreIndex = 0;
  let lastStoreKey: unknown = undefined;
  let footerFound = false;
  let footer: PortableBackupFooterRecord | undefined = undefined;

  for (let i = 1; i < rawLines.length; i++) {
    const lineStr = rawLines[i];
    if (!lineStr || lineStr.trim() === '') continue; // ignore stray empty lines if any

    let parsedLine: any;
    try {
      parsedLine = JSON.parse(lineStr);
    } catch (err) {
      errors.push({
        code: 'malformed_json_line',
        message: `Line ${i} is not valid JSON: ${(err as Error).message}`,
        lineIndex: i,
      });
      continue;
    }

    if (footerFound) {
      errors.push({
        code: 'records_after_footer',
        message: `Found record after footer line at index ${i}`,
        lineIndex: i,
      });
      continue;
    }

    if (parsedLine.kind === 'manifest') {
      errors.push({
        code: 'duplicate_manifest',
        message: `Encountered unexpected second manifest line at index ${i}`,
        lineIndex: i,
      });
      continue;
    }

    if (parsedLine.kind === 'footer') {
      footerFound = true;
      footer = parsedLine as PortableBackupFooterRecord;
      if (!footer.complete) {
        errors.push({
          code: 'incomplete_footer',
          message: 'Footer specifies complete: false',
          lineIndex: i,
        });
      }
      continue;
    }

    if (parsedLine.kind === 'record') {
      const record = parsedLine as PortableBackupStoreRecord;
      const storeName = record.store;

      if (!validStoresSet.has(storeName)) {
        errors.push({
          code: 'unknown_backup_store',
          message: `Unknown or disallowed store name in record: "${storeName}"`,
          lineIndex: i,
        });
        continue;
      }

      // Verify deterministic store order
      const expectedStore = INCLUDED_BACKUP_STORES[currentStoreIndex];
      if (storeName !== expectedStore) {
        const nextIdx = INCLUDED_BACKUP_STORES.indexOf(storeName);
        if (nextIdx > currentStoreIndex) {
          // Advanced to next store
          currentStoreIndex = nextIdx;
          lastStoreKey = undefined;
        } else {
          // Out of order store transition
          errors.push({
            code: 'stores_out_of_order',
            message: `Store "${storeName}" appeared after store "${expectedStore}" had already completed.`,
            lineIndex: i,
          });
        }
      }

      // Verify primary key ordering within store
      const primaryKey = record.value?.id;
      if (lastStoreKey !== undefined && primaryKey !== undefined) {
        if (compareKeys(primaryKey, lastStoreKey) < 0) {
          errors.push({
            code: 'records_not_sorted',
            message: `Store "${storeName}" records not in ascending primary-key order: key "${primaryKey}" followed "${lastStoreKey}"`,
            lineIndex: i,
          });
        }
      }
      lastStoreKey = primaryKey;

      observedCounts[storeName as IncludedBackupStoreName]++;
      continue;
    }

    errors.push({
      code: 'unknown_record_kind',
      message: `Unknown record kind "${parsedLine.kind}" at line ${i}`,
      lineIndex: i,
    });
  }

  // 6. Verify footer existence and exact counts
  if (!footerFound || !footer) {
    errors.push({
      code: 'missing_backup_footer',
      message: 'Backup archive ended without a complete footer record (truncated backup).',
    });
  } else if (footer.counts) {
    for (const storeName of INCLUDED_BACKUP_STORES) {
      const expected = footer.counts[storeName] ?? -1;
      const actual = observedCounts[storeName] ?? 0;
      if (expected !== actual) {
        errors.push({
          code: 'footer_count_mismatch',
          message: `Count mismatch for store "${storeName}": footer declared ${expected}, actual was ${actual}`,
        });
      }
    }
  } else {
    errors.push({
      code: 'missing_footer_counts',
      message: 'Footer record does not contain counts object.',
    });
  }

  const valid = errors.length === 0;
  const totalRecords = Object.values(observedCounts).reduce((acc, c) => acc + c, 0);

  return {
    valid,
    format: manifest?.format,
    formatVersion: manifest?.formatVersion,
    createdAt: manifest?.createdAt,
    appVersion: manifest?.appVersion,
    sourceDatabaseVersion: manifest?.sourceDatabaseVersion,
    counts: observedCounts,
    totalRecords,
    errors,
  };
}
