import type { PortableBackupSnapshot } from './snapshot';

/**
 * Create a ReadableStream of Uint8Array chunks that serializes each line of
 * the snapshot (manifest, records, footer) incrementally in NDJSON format.
 */
export function createSnapshotReadableStream(snapshot: PortableBackupSnapshot): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let step = 0;
  let recordIdx = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) {
        // Manifest line
        controller.enqueue(encoder.encode(JSON.stringify(snapshot.manifest) + '\n'));
        step = 1;
        return;
      }

      if (step === 1) {
        // Batch records in small chunks (e.g. 50 records per pull) to minimize loop overhead
        const batchSize = 50;
        let chunkStr = '';
        for (let i = 0; i < batchSize && recordIdx < snapshot.records.length; i++) {
          chunkStr += JSON.stringify(snapshot.records[recordIdx]) + '\n';
          recordIdx++;
        }

        if (chunkStr.length > 0) {
          controller.enqueue(encoder.encode(chunkStr));
        }

        if (recordIdx >= snapshot.records.length) {
          step = 2;
        }
        return;
      }

      if (step === 2) {
        // Footer line
        controller.enqueue(encoder.encode(JSON.stringify(snapshot.footer) + '\n'));
        step = 3;
        controller.close();
      }
    },
  });
}

/**
 * Build a compressed backup file (.streamarchive.jsonl.gz) from a snapshot
 * using streaming native gzip compression.
 */
export async function buildCompressedBackup(snapshot: PortableBackupSnapshot): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not supported in this runtime environment.');
  }

  const rawStream = createSnapshotReadableStream(snapshot);
  const compressedStream = rawStream.pipeThrough(
    new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
  );
  const response = new Response(compressedStream);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Serialize a snapshot to uncompressed NDJSON string (primarily for debugging and tests).
 */
export function serializeSnapshotToJsonl(snapshot: PortableBackupSnapshot): string {
  const lines: string[] = [];
  lines.push(JSON.stringify(snapshot.manifest));
  for (const record of snapshot.records) {
    lines.push(JSON.stringify(record));
  }
  lines.push(JSON.stringify(snapshot.footer));
  return lines.join('\n') + '\n';
}
