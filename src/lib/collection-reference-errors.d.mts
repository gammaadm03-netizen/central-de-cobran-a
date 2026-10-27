export type CollectionReferenceAction = 'begin' | 'status' | 'history' | 'verify_original' | 'stage' | 'finish_prepare' | 'preview' | 'publish';
export interface CollectionReferenceFailure { action: CollectionReferenceAction; code: string; activation_required: boolean; status?: number; schema_version?: string; request_id?: string; phase?: string }
export function makeCollectionReferenceFailure(input?: { action?: unknown; status?: unknown; code?: unknown; payload?: unknown }): CollectionReferenceFailure;
export function collectionReferenceFailureReference(error: unknown, action?: CollectionReferenceAction): string;
export function collectionReferenceFailureMessage(error: unknown, fallback: string): string;
