import type { TransportEvent } from '../../transport/types';

export type TransportEventHandler = (event: TransportEvent) => void;

export interface TransportCapture {
  readonly transportName: string;
  start(handler: TransportEventHandler): void;
  stop(): void;
  isObserving(): boolean;
}
