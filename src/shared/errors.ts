export class StreamArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamArchiveError';
  }
}

export class BridgeValidationError extends StreamArchiveError {
  constructor(message: string, public readonly receivedPayload?: unknown) {
    super(message);
    this.name = 'BridgeValidationError';
  }
}

export class StorageTransactionError extends StreamArchiveError {
  constructor(message: string, public readonly causeError?: unknown) {
    super(message);
    this.name = 'StorageTransactionError';
  }
}
