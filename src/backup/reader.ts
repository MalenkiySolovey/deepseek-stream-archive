/**
 * Streaming Portable Backup Reader & Decompression Bomb Protection.
 *
 * Implements bounded, streaming gzip decompression, incremental NDJSON parsing,
 * strict Backup Format v1 envelope validation, and in-memory record materialization.
 */

import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  INCLUDED_BACKUP_STORES,
  EXCLUDED_BACKUP_STORES,
  type IncludedBackupStoreName,
  type PortableBackupStoreCounts,
  type PortableBackupManifestRecord,
  type PortableBackupFooterRecord,
  type PortableBackupStoreRecord,
} from './format';
import { validateStoreRecord } from './record-validation';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../core/models';
import type { RawStreamRecord, RawStreamBatch } from '../storage/raw-journal/types';

/**
 * Defensive Bounded Import Limits:
 * Sized to accommodate large historical archives (e.g. 163+ MiB raw, up to 2 GiB uncompressed)
 * with robust decompression bomb protection:
 * - Maximum compressed input: 500 MiB (prevents multi-gigabyte raw payload ingestion).
 * - Maximum decompressed text: 2048 MiB (2 GiB) (prevents gzip bomb memory exhaustion).
 * - Maximum records: 5,000,000 (prevents micro-record object explosion).
 * - Maximum line length: 50 MiB (allows massive thinking chains or responses).
 */
export const MAX_IMPORT_COMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MiB
export const MAX_IMPORT_DECOMPRESSED_BYTES = 2048 * 1024 * 1024; // 2048 MiB (2 GiB)
export const MAX_IMPORT_RECORDS = 5_000_000;
export const MAX_IMPORT_LINE_CHARS = 50 * 1024 * 1024; // 50 MiB

export interface ReadPortableBackupOptions {
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  maxRecords?: number;
  maxLineChars?: number;
  inspectionOnly?: boolean;
  onRecord?: (store: IncludedBackupStoreName, record: Record<string, unknown>) => Promise<void> | void;
}

export interface BackupValidationError {
  code: string;
  message: string;
  lineIndex?: number;
}

export interface MaterializedPortableBackup {
  manifest: PortableBackupManifestRecord;
  records: {
    conversations: Conversation[];
    messages: Message[];
    revisions: ResponseRevision[];
    recovery_events: RecoveryEvent[];
    raw_streams: RawStreamRecord[];
    raw_stream_batches: RawStreamBatch[];
  };
  footer: PortableBackupFooterRecord;
}

export interface BackupReadResult {
  success: boolean;
  backup?: MaterializedPortableBackup;
  errors: BackupValidationError[];
  decompressedBytes: number;
  compressedBytes: number;
  totalRecords: number;
}

function compareKeys(a: unknown, b: unknown): number {
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  if (strA < strB) return -1;
  if (strA > strB) return 1;
  return 0;
}

/**
 * Parse and validate a Portable Backup archive (.streamarchive.jsonl.gz).
 * Enforces streaming decompression, decompression bomb byte ceilings,
 * line-by-line schema validation, and monotonic store and key order.
 */
export async function readPortableBackup(
  input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  options?: ReadPortableBackupOptions
): Promise<BackupReadResult> {
  const errors: BackupValidationError[] = [];
  const maxCompressed = options?.maxCompressedBytes ?? MAX_IMPORT_COMPRESSED_BYTES;
  const maxDecompressed = options?.maxDecompressedBytes ?? MAX_IMPORT_DECOMPRESSED_BYTES;
  const maxRecords = options?.maxRecords ?? MAX_IMPORT_RECORDS;
  const maxLineChars = options?.maxLineChars ?? MAX_IMPORT_LINE_CHARS;

  let compressedStream: ReadableStream<Uint8Array>;
  let compressedBytes = 0;

  if (input instanceof ReadableStream) {
    compressedStream = input;
  } else if (input && typeof (input as any).stream === 'function' && typeof (input as any).size === 'number') {
    compressedBytes = (input as any).size;
    if (compressedBytes > maxCompressed) {
      return {
        success: false,
        errors: [
          {
            code: 'compressed_backup_too_large',
            message: `Compressed backup size (${compressedBytes} bytes) exceeds maximum allowable limit of ${maxCompressed} bytes.`,
          },
        ],
        decompressedBytes: 0,
        compressedBytes,
        totalRecords: 0,
      };
    }
    compressedStream = (input as any).stream();
  } else if (input instanceof Blob) {
    compressedBytes = input.size;
    if (compressedBytes > maxCompressed) {
      return {
        success: false,
        errors: [
          {
            code: 'compressed_backup_too_large',
            message: `Compressed backup size (${compressedBytes} bytes) exceeds maximum allowable limit of ${maxCompressed} bytes.`,
          },
        ],
        decompressedBytes: 0,
        compressedBytes,
        totalRecords: 0,
      };
    }
    compressedStream = input.stream();
  } else {
    const u8 = input instanceof ArrayBuffer ? new Uint8Array(input) : (input as Uint8Array);
    compressedBytes = u8.byteLength;
    if (compressedBytes > maxCompressed) {
      return {
        success: false,
        errors: [
          {
            code: 'compressed_backup_too_large',
            message: `Compressed backup size (${compressedBytes} bytes) exceeds maximum allowable limit of ${maxCompressed} bytes.`,
          },
        ],
        decompressedBytes: 0,
        compressedBytes,
        totalRecords: 0,
      };
    }
    compressedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(u8);
        controller.close();
      },
    });
  }

  // Set up decompression stream
  let decompressedStream: ReadableStream<Uint8Array>;
  try {
    const ds = new DecompressionStream('gzip');
    decompressedStream = compressedStream.pipeThrough(
      ds as unknown as TransformStream<Uint8Array, Uint8Array>
    );
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          code: 'corrupt_gzip_stream',
          message: `Failed to initialize gzip decompression stream: ${(err as Error).message}`,
        },
      ],
      decompressedBytes: 0,
      compressedBytes,
      totalRecords: 0,
    };
  }

  const reader = decompressedStream.getReader();
  const textDecoder = new TextDecoder('utf-8', { fatal: true });

  let decompressedBytes = 0;
  let lineBuffer = '';
  let lineIndex = 0;
  let manifest: PortableBackupManifestRecord | undefined = undefined;
  let footer: PortableBackupFooterRecord | undefined = undefined;
  let footerFound = false;

  const records: MaterializedPortableBackup['records'] = {
    conversations: [],
    messages: [],
    revisions: [],
    recovery_events: [],
    raw_streams: [],
    raw_stream_batches: [],
  };

  const observedCounts: PortableBackupStoreCounts = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };

  const validStoresSet = new Set<string>(INCLUDED_BACKUP_STORES);
  const seenPrimaryKeysByStore = new Map<string, Set<string>>([
    ['conversations', new Set()],
    ['messages', new Set()],
    ['revisions', new Set()],
    ['recovery_events', new Set()],
    ['raw_streams', new Set()],
    ['raw_stream_batches', new Set()],
  ]);

  let currentStoreIndex = 0;
  let lastStoreKey: unknown = undefined;

  function processLine(lineText: string, currentLineIndex: number): boolean {
    const trimmed = lineText.replace(/\r$/, '');
    if (trimmed.trim() === '') return true;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      errors.push({
        code: 'malformed_json_line',
        message: `Line ${currentLineIndex} is not valid JSON: ${(err as Error).message}`,
        lineIndex: currentLineIndex,
      });
      return false;
    }

    // Line 0 must be manifest
    if (currentLineIndex === 0) {
      if (!parsed || parsed.kind !== 'manifest') {
        errors.push({
          code: 'missing_manifest',
          message: `First line must have kind="manifest", found "${parsed?.kind}"`,
          lineIndex: 0,
        });
        return false;
      }

      manifest = parsed as PortableBackupManifestRecord;

      if (manifest.format !== PORTABLE_BACKUP_FORMAT) {
        errors.push({
          code: 'invalid_backup_format',
          message: `Unknown backup format: "${manifest.format}". Expected "${PORTABLE_BACKUP_FORMAT}".`,
          lineIndex: 0,
        });
        return false;
      }

      if (typeof manifest.formatVersion === 'number' && manifest.formatVersion > PORTABLE_BACKUP_FORMAT_VERSION) {
        errors.push({
          code: 'unsupported_backup_version',
          message: `Backup format version ${manifest.formatVersion} is newer than supported version ${PORTABLE_BACKUP_FORMAT_VERSION}.`,
          lineIndex: 0,
        });
        return false;
      }

      if (manifest.formatVersion !== PORTABLE_BACKUP_FORMAT_VERSION) {
        errors.push({
          code: 'invalid_format_version',
          message: `Unsupported formatVersion: ${manifest.formatVersion}`,
          lineIndex: 0,
        });
        return false;
      }

      if (manifest.encoding !== 'utf-8') {
        errors.push({
          code: 'invalid_manifest_encoding',
          message: `Manifest requires encoding="utf-8", found "${manifest.encoding}"`,
          lineIndex: 0,
        });
      }

      if (manifest.compression !== 'gzip') {
        errors.push({
          code: 'invalid_manifest_compression',
          message: `Manifest requires compression="gzip", found "${manifest.compression}"`,
          lineIndex: 0,
        });
      }

      if (!Array.isArray(manifest.includedStores)) {
        errors.push({
          code: 'invalid_included_stores',
          message: 'Manifest includedStores must be an array of store names.',
          lineIndex: 0,
        });
      } else {
        const incSet = new Set(manifest.includedStores);
        for (const store of INCLUDED_BACKUP_STORES) {
          if (!incSet.has(store)) {
            errors.push({
              code: 'missing_included_store',
              message: `Manifest includedStores is missing required store "${store}".`,
              lineIndex: 0,
            });
          }
        }
      }

      if (!Array.isArray(manifest.excludedStores)) {
        errors.push({
          code: 'invalid_excluded_stores',
          message: 'Manifest excludedStores must be an array of store names.',
          lineIndex: 0,
        });
      }

      if (typeof manifest.createdAt !== 'number' || !Number.isFinite(manifest.createdAt) || manifest.createdAt <= 0) {
        errors.push({
          code: 'invalid_manifest_created_at',
          message: 'Manifest createdAt must be a positive finite timestamp.',
          lineIndex: 0,
        });
      }

      if (typeof manifest.appVersion !== 'string' || manifest.appVersion.trim().length === 0) {
        errors.push({
          code: 'invalid_manifest_app_version',
          message: 'Manifest appVersion must be a non-empty string.',
          lineIndex: 0,
        });
      }

      if (typeof manifest.sourceDatabase !== 'string' || manifest.sourceDatabase.trim().length === 0) {
        errors.push({
          code: 'invalid_manifest_source_db',
          message: 'Manifest sourceDatabase must be a non-empty string.',
          lineIndex: 0,
        });
      }

      if (typeof manifest.sourceDatabaseVersion !== 'number' || !Number.isInteger(manifest.sourceDatabaseVersion) || manifest.sourceDatabaseVersion <= 0) {
        errors.push({
          code: 'invalid_manifest_source_db_version',
          message: 'Manifest sourceDatabaseVersion must be a positive integer.',
          lineIndex: 0,
        });
      }

      if (!parsed.privacy || typeof parsed.privacy !== 'object') {
        errors.push({
          code: 'invalid_manifest_privacy',
          message: 'Manifest requires a privacy metadata object.',
          lineIndex: 0,
        });
      }

      return true;
    }

    if (footerFound) {
      errors.push({
        code: 'records_after_footer',
        message: `Found record after footer line at index ${currentLineIndex}`,
        lineIndex: currentLineIndex,
      });
      return false;
    }

    if (parsed.kind === 'manifest') {
      errors.push({
        code: 'duplicate_manifest',
        message: `Encountered unexpected second manifest line at index ${currentLineIndex}`,
        lineIndex: currentLineIndex,
      });
      return false;
    }

    if (parsed.kind === 'footer') {
      footerFound = true;
      footer = parsed as PortableBackupFooterRecord;
      if (!footer.complete) {
        errors.push({
          code: 'incomplete_footer',
          message: 'Footer specifies complete: false',
          lineIndex: currentLineIndex,
        });
      }
      return true;
    }

    if (parsed.kind === 'record') {
      const record = parsed as PortableBackupStoreRecord;
      const storeName = record.store;

      if (!validStoresSet.has(storeName)) {
        errors.push({
          code: 'unknown_backup_store',
          message: `Unknown or disallowed store name in record: "${storeName}"`,
          lineIndex: currentLineIndex,
        });
        return false;
      }

      // Verify deterministic store order
      const expectedStore = INCLUDED_BACKUP_STORES[currentStoreIndex];
      if (storeName !== expectedStore) {
        const nextIdx = INCLUDED_BACKUP_STORES.indexOf(storeName);
        if (nextIdx > currentStoreIndex) {
          currentStoreIndex = nextIdx;
          lastStoreKey = undefined;
        } else {
          errors.push({
            code: 'stores_out_of_order',
            message: `Store "${storeName}" appeared after store "${expectedStore}" had already completed.`,
            lineIndex: currentLineIndex,
          });
          return false;
        }
      }

      const primaryKey = record.value?.id;
      if (typeof primaryKey !== 'string' || primaryKey.trim().length === 0) {
        errors.push({
          code: 'missing_primary_key',
          message: `Record at line ${currentLineIndex} in store "${storeName}" is missing a valid string primary key "id"`,
          lineIndex: currentLineIndex,
        });
        return false;
      }

      // Verify primary key ordering within store
      if (lastStoreKey !== undefined && primaryKey !== undefined) {
        const cmp = compareKeys(primaryKey, lastStoreKey);
        if (cmp < 0) {
          errors.push({
            code: 'records_not_sorted',
            message: `Store "${storeName}" records not in ascending primary-key order: key "${primaryKey}" followed "${lastStoreKey}"`,
            lineIndex: currentLineIndex,
          });
          return false;
        }
      }
      lastStoreKey = primaryKey;

      // Duplicate primary key check in same backup
      const seenKeys = seenPrimaryKeysByStore.get(storeName)!;
      if (seenKeys.has(primaryKey)) {
        errors.push({
          code: 'duplicate_primary_key',
          message: `Duplicate primary key "${primaryKey}" detected in store "${storeName}" at line ${currentLineIndex}`,
          lineIndex: currentLineIndex,
        });
        return false;
      }
      seenKeys.add(primaryKey);

      // Validate record schema
      const valRes = validateStoreRecord(storeName, record.value);
      if (!valRes.valid) {
        errors.push({
          code: 'invalid_record_schema',
          message: `Record schema invalid in store "${storeName}" at line ${currentLineIndex}: ${valRes.error}`,
          lineIndex: currentLineIndex,
        });
        return false;
      }

      // Add to materialized records (unless inspectionOnly mode is active for bounded memory)
      if (!options?.inspectionOnly) {
        switch (storeName) {
          case 'conversations':
            records.conversations.push(valRes.record as Conversation);
            break;
          case 'messages':
            records.messages.push(valRes.record as Message);
            break;
          case 'revisions':
            records.revisions.push(valRes.record as ResponseRevision);
            break;
          case 'recovery_events':
            records.recovery_events.push(valRes.record as RecoveryEvent);
            break;
          case 'raw_streams':
            records.raw_streams.push(valRes.record as RawStreamRecord);
            break;
          case 'raw_stream_batches':
            records.raw_stream_batches.push(valRes.record as RawStreamBatch);
            break;
        }
      }

      if (options?.onRecord) {
        options.onRecord(storeName as IncludedBackupStoreName, valRes.record as Record<string, unknown>);
      }

      observedCounts[storeName as IncludedBackupStoreName]++;

      const totalSoFar = Object.values(observedCounts).reduce((acc, c) => acc + c, 0);
      if (totalSoFar > maxRecords) {
        errors.push({
          code: 'excessive_record_count',
          message: `Record count (${totalSoFar}) exceeds maximum allowable limit of ${maxRecords} records.`,
          lineIndex: currentLineIndex,
        });
        return false;
      }

      return true;
    }

    errors.push({
      code: 'unknown_record_kind',
      message: `Unknown record kind "${parsed.kind}" at line ${currentLineIndex}`,
      lineIndex: currentLineIndex,
    });
    return false;
  }

  // Decompress and process stream chunk by chunk
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush remaining buffer
        const remaining = textDecoder.decode();
        lineBuffer += remaining;
        if (lineBuffer.trim().length > 0) {
          processLine(lineBuffer, lineIndex);
          lineIndex++;
        }
        break;
      }

      decompressedBytes += value.byteLength;
      if (decompressedBytes > maxDecompressed) {
        errors.push({
          code: 'decompression_bomb_detected',
          message: `Decompressed stream exceeded safety threshold of ${maxDecompressed} bytes.`,
        });
        await reader.cancel();
        break;
      }

      const textChunk = textDecoder.decode(value, { stream: true });
      lineBuffer += textChunk;

      let newlineIndex: number;
      while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);

        if (line.length > maxLineChars) {
          errors.push({
            code: 'line_too_large',
            message: `Line ${lineIndex} exceeds maximum allowable line size of ${maxLineChars} characters.`,
            lineIndex,
          });
          await reader.cancel();
          break;
        }

        const continueParsing = processLine(line, lineIndex);
        lineIndex++;
        if (!continueParsing) {
          // In case of fatal errors like unsupported version, abort reading early
          if (errors.some((e) => e.code === 'unsupported_backup_version' || e.code === 'invalid_backup_format')) {
            await reader.cancel();
            break;
          }
        }
      }

      if (errors.some((e) => e.code === 'unsupported_backup_version' || e.code === 'invalid_backup_format')) {
        break;
      }
    }
  } catch (err) {
    errors.push({
      code: 'corrupt_gzip_stream',
      message: `Decompression error: ${(err as Error).message}`,
    });
  }

  // Check footer presence & count parity
  const actualFooter = footer as PortableBackupFooterRecord | undefined;
  if (!footerFound || !actualFooter) {
    if (!errors.some((e) => e.code === 'unsupported_backup_version' || e.code === 'invalid_backup_format')) {
      errors.push({
        code: 'missing_backup_footer',
        message: 'Backup archive ended without a complete footer record (truncated backup).',
      });
    }
  } else if (actualFooter.counts) {
    for (const storeName of INCLUDED_BACKUP_STORES) {
      const expected = actualFooter.counts[storeName] ?? -1;
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

  const success = errors.length === 0;
  const totalRecords = Object.values(observedCounts).reduce((acc, c) => acc + c, 0);

  return {
    success,
    backup: success && manifest && footer ? { manifest, records, footer } : undefined,
    errors,
    decompressedBytes,
    compressedBytes,
    totalRecords,
  };
}
