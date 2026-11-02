/**
 * Safe local file saving abstraction for human exports and portable backups.
 * Uses window.showSaveFilePicker() where available, with safe Blob fallback.
 * Strictly avoids chrome.downloads permission.
 */

export interface SaveFileOptions {
  suggestedName: string;
  mimeType: string;
  data: Uint8Array | Blob | string;
  description?: string;
  extension?: string;
}

export interface SaveFileResult {
  success: boolean;
  canceled?: boolean;
  error?: string;
}

export interface SaveFileAdapter {
  save(options: SaveFileOptions): Promise<SaveFileResult>;
}

/**
 * Chromium File System Access API adapter (showSaveFilePicker).
 */
export class FileSystemAccessSaveAdapter implements SaveFileAdapter {
  async save(options: SaveFileOptions): Promise<SaveFileResult> {
    if (typeof window === 'undefined' || typeof (window as any).showSaveFilePicker !== 'function') {
      return { success: false, error: 'showSaveFilePicker is not supported in this environment' };
    }

    try {
      const ext = options.extension || (options.suggestedName.includes('.') ? options.suggestedName.split('.').pop()! : 'bin');
      const pickerOptions: any = {
        suggestedName: options.suggestedName,
        types: [
          {
            description: options.description || 'Backup Archive',
            accept: {
              [options.mimeType]: [`.${ext}`],
            },
          },
        ],
      };

      const handle = await (window as any).showSaveFilePicker(pickerOptions);
      const writable = await handle.createWritable();

      let payload: Blob | Uint8Array | string = options.data;
      if (typeof payload === 'string') {
        payload = new TextEncoder().encode(payload);
      }

      await writable.write(payload);
      await writable.close();

      return { success: true };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // User closed or canceled the file picker dialog
        return { success: false, canceled: true };
      }
      return { success: false, error: err?.message || String(err) };
    }
  }
}

/**
 * Fallback browser adapter using temporary Blob URL and <a download>.
 */
export class BlobDownloadFallbackAdapter implements SaveFileAdapter {
  async save(options: SaveFileOptions): Promise<SaveFileResult> {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      return { success: false, error: 'DOM environment is not available for Blob download' };
    }

    try {
      let blob: Blob;
      if (options.data instanceof Blob) {
        blob = options.data;
      } else if (typeof options.data === 'string') {
        blob = new Blob([options.data], { type: options.mimeType });
      } else {
        blob = new Blob([options.data as any], { type: options.mimeType });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = options.suggestedName;

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Clean up object URL safely after download gesture dispatches
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore cleanup errors
        }
      }, 2000);

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }
}

/**
 * Default global adapter strategy.
 */
let activeAdapter: SaveFileAdapter | null = null;

export function setCustomSaveFileAdapter(adapter: SaveFileAdapter | null): void {
  activeAdapter = adapter;
}

export async function saveLocalFile(options: SaveFileOptions): Promise<SaveFileResult> {
  if (activeAdapter) {
    return activeAdapter.save(options);
  }

  // Try File System Access API first if available
  if (typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function') {
    const fsAdapter = new FileSystemAccessSaveAdapter();
    const result = await fsAdapter.save(options);
    if (result.success || result.canceled) {
      return result;
    }
    // If showSaveFilePicker threw a non-cancel error, fall through to Blob download
  }

  // Fallback to Blob download
  const blobAdapter = new BlobDownloadFallbackAdapter();
  return blobAdapter.save(options);
}
