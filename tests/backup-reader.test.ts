import { describe, it, expect } from 'vitest';
import { readPortableBackup, MAX_IMPORT_COMPRESSED_BYTES } from '../src/backup/reader';
import { compressGzip } from '../src/backup/compression';
import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  INCLUDED_BACKUP_STORES,
  EXCLUDED_BACKUP_STORES,
  type PortableBackupManifestRecord,
  type PortableBackupFooterRecord,
} from '../src/backup/format';

function makeValidManifest(overrides?: Partial<PortableBackupManifestRecord>): PortableBackupManifestRecord {
  return {
    kind: 'manifest',
    format: PORTABLE_BACKUP_FORMAT,
    formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
    createdAt: 1700000000000,
    appVersion: '0.1.0',
    sourceDatabase: 'StreamArchiveDB',
    sourceDatabaseVersion: 8,
    encoding: 'utf-8',
    compression: 'gzip',
    includedStores: [...INCLUDED_BACKUP_STORES],
    excludedStores: [...EXCLUDED_BACKUP_STORES],
    privacy: {
      containsConversationContent: true,
      containsReasoning: true,
      containsRecoveredContent: true,
      containsRawNetworkEvidence: true,
    },
    ...overrides,
  };
}

function makeValidFooter(counts?: Partial<PortableBackupFooterRecord['counts']>): PortableBackupFooterRecord {
  return {
    kind: 'footer',
    complete: true,
    counts: {
      conversations: 0,
      messages: 0,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
      ...counts,
    },
  };
}

async function makeCompressedArchive(lines: any[]): Promise<Uint8Array> {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const u8 = new TextEncoder().encode(text);
  return compressGzip(u8);
}

describe('Streaming Backup Reader & Security Bounds (Decompression Bomb Protection)', () => {
  it('reads a valid minimal backup archive successfully', async () => {
    const gz = await makeCompressedArchive([makeValidManifest(), makeValidFooter()]);
    const res = await readPortableBackup(gz);

    expect(res.success).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.backup?.manifest.format).toBe(PORTABLE_BACKUP_FORMAT);
    expect(res.backup?.footer.complete).toBe(true);
    expect(res.totalRecords).toBe(0);
  });

  it('rejects input exceeding MAX_IMPORT_COMPRESSED_BYTES preflight', async () => {
    const oversizedBlob = {
      size: MAX_IMPORT_COMPRESSED_BYTES + 1024,
      stream: () => new ReadableStream(),
    } as unknown as Blob;

    const res = await readPortableBackup(oversizedBlob);
    expect(res.success).toBe(false);
    expect(res.errors[0]?.code).toBe('compressed_backup_too_large');
  });

  it('aborts on decompression bomb expanding past safety threshold', async () => {
    // Generate an artificial gzip bomb with a small threshold for instant test execution
    const repeatSize = 64 * 1024; // 64 KB chunk
    const chunk = new Uint8Array(repeatSize);
    chunk.fill(32); // spaces

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const cs = new CompressionStream('gzip');
    const compressedGzStream = stream.pipeThrough(cs as unknown as TransformStream<Uint8Array, Uint8Array>);

    // Set maxDecompressedBytes to 10 KB to trigger bomb protection immediately
    const res = await readPortableBackup(compressedGzStream, { maxDecompressedBytes: 10 * 1024 });
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'decompression_bomb_detected')).toBe(true);
  });

  it('rejects corrupt gzip stream with invalid header magic bytes', async () => {
    const badBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    const res = await readPortableBackup(badBytes);
    expect(res.success).toBe(false);
    expect(res.errors[0]?.code).toBe('corrupt_gzip_stream');
  });

  it('rejects archive with missing manifest on line 0', async () => {
    const gz = await makeCompressedArchive([
      { kind: 'record', store: 'conversations', value: { id: 'c1' } },
      makeValidFooter(),
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'missing_manifest')).toBe(true);
  });

  it('rejects archive with duplicate manifest line', async () => {
    const gz = await makeCompressedArchive([
      makeValidManifest(),
      makeValidManifest(),
      makeValidFooter(),
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'duplicate_manifest')).toBe(true);
  });

  it('rejects archive with records after footer', async () => {
    const gz = await makeCompressedArchive([
      makeValidManifest(),
      makeValidFooter(),
      { kind: 'record', store: 'conversations', value: { id: 'c1' } },
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'records_after_footer')).toBe(true);
  });

  it('rejects truncated archive with missing footer', async () => {
    const gz = await makeCompressedArchive([makeValidManifest()]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'missing_backup_footer')).toBe(true);
  });

  it('rejects archive with footer record count mismatch', async () => {
    const gz = await makeCompressedArchive([
      makeValidManifest(),
      {
        kind: 'record',
        store: 'conversations',
        value: { id: 'c1', title: 'T', createdAt: 1, updatedAt: 1 },
      },
      makeValidFooter({ conversations: 5 }), // declared 5, actual was 1
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'footer_count_mismatch')).toBe(true);
  });

  it('rejects duplicate primary keys in the same backup store', async () => {
    const gz = await makeCompressedArchive([
      makeValidManifest(),
      {
        kind: 'record',
        store: 'conversations',
        value: { id: 'c1', title: 'T1', createdAt: 1, updatedAt: 1 },
      },
      {
        kind: 'record',
        store: 'conversations',
        value: { id: 'c1', title: 'T2', createdAt: 2, updatedAt: 2 },
      },
      makeValidFooter({ conversations: 2 }),
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'duplicate_primary_key')).toBe(true);
  });

  it('rejects stores appearing out of order', async () => {
    const gz = await makeCompressedArchive([
      makeValidManifest(),
      {
        kind: 'record',
        store: 'messages',
        value: { id: 'm1', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 1, updatedAt: 1 },
      },
      {
        kind: 'record',
        store: 'conversations', // Appears after messages!
        value: { id: 'c1', title: 'T', createdAt: 1, updatedAt: 1 },
      },
      makeValidFooter({ conversations: 1, messages: 1 }),
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'stores_out_of_order')).toBe(true);
  });

  it('rejects records not sorted by primary key in ascending order', async () => {
    const gz = await makeCompressedArchive([
      makeValidManifest(),
      {
        kind: 'record',
        store: 'conversations',
        value: { id: 'conv-z', title: 'Z', createdAt: 1, updatedAt: 1 },
      },
      {
        kind: 'record',
        store: 'conversations',
        value: { id: 'conv-a', title: 'A', createdAt: 1, updatedAt: 1 }, // Out of order!
      },
      makeValidFooter({ conversations: 2 }),
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'records_not_sorted')).toBe(true);
  });

  it('rejects unsupported future format version', async () => {
    const gz = await makeCompressedArchive([
      makeValidManifest({ formatVersion: 99 as any }),
      makeValidFooter(),
    ]);
    const res = await readPortableBackup(gz);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.code === 'unsupported_backup_version')).toBe(true);
  });
});
