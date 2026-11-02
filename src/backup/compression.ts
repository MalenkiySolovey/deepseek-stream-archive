/**
 * Native browser-standard gzip compression and decompression helpers
 * using CompressionStream and DecompressionStream (zero external dependencies).
 */

/**
 * Compress an uncompressed byte stream or buffer using gzip.
 */
export async function compressGzip(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not supported in this runtime environment.');
  }

  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  const compressedStream = inputStream.pipeThrough(
    new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
  );
  const response = new Response(compressedStream);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Decompress a gzip-compressed byte buffer using DecompressionStream.
 */
export async function decompressGzip(compressedData: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const bytes = compressedData instanceof Uint8Array ? compressedData : new Uint8Array(compressedData);

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this runtime environment.');
  }

  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  const decompressedStream = inputStream.pipeThrough(
    new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
  );
  const response = new Response(decompressedStream);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
