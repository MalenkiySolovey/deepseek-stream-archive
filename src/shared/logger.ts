const LOG_PREFIX = '[StreamArchive]';

export const logger = {
  info(message: string, ...meta: unknown[]): void {
    console.log(`${LOG_PREFIX} ${message}`, ...meta);
  },
  warn(message: string, ...meta: unknown[]): void {
    console.warn(`${LOG_PREFIX} ⚠ ${message}`, ...meta);
  },
  error(message: string, ...meta: unknown[]): void {
    console.error(`${LOG_PREFIX} ✗ ${message}`, ...meta);
  },
  debug(message: string, ...meta: unknown[]): void {
    // Only in non-production environments
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`${LOG_PREFIX} [DEBUG] ${message}`, ...meta);
    }
  },
};
