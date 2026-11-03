import type { PageRecoveryMessageSummary } from '../../adapters/deepseek/dom/types';
import type { OverlayContentResult } from '../../overlay/portal';

export interface InlineHostHandle {
  messageId: string;
  remoteId: string;
  hostElement: HTMLElement;
  shadowRoot: ShadowRoot;
  containerElement: HTMLElement;
  unmount: () => void;
}

export interface ReversibleHostMutation {
  element: HTMLElement;
  previousDisplay: string;
}

export interface InlineRecoveryPresentationOptions {
  showThinkingInline: boolean;
  locale?: 'en' | 'ru';
  continuityStatus?: string;
  onCopyAnswer?: (text: string) => Promise<boolean> | boolean | void;
  onCopyCode?: (code: string) => Promise<boolean> | boolean | void;
}


export interface InlineRecoveryRenderParams {
  message: PageRecoveryMessageSummary;
  content: OverlayContentResult;
  options?: InlineRecoveryPresentationOptions;
}
