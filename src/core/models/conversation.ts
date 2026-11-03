export interface Conversation {
  id: string;
  remoteId?: string;
  title: string;
  currentMessageId?: string;
  createdAt: number;
  updatedAt: number;
}
