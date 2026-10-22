export type KnownTerminalStatus =
  | 'FINISHED'
  | 'CONTENT_FILTER'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'INCOMPLETE'
  | 'TIMEOUT';

export type KnownNonTerminalStatus = 'WIP' | 'AUTO_CONTINUE';

export type KnownSseEventName =
  | 'message'
  | 'ready'
  | 'update_session'
  | 'finish'
  | 'title'
  | 'close';

export interface DeepSeekCompatibilityProfile {
  id: string;
  name: string;
  version: string;
  description: string;
  generationEndpoints: string[];
  excludedEndpoints: string[];
  supportedPatchOperations: ('SET' | 'APPEND' | 'REPLACE' | 'BATCH')[];
  filterStatusMarkers: string[];
  filterFragmentTypes: string[];
  terminalStatuses: KnownTerminalStatus[];
  nonTerminalStatuses: KnownNonTerminalStatus[];
  knownFragmentTypes: string[];
  knownEventNames: string[];
}

