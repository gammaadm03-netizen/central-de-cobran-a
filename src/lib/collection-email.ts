import { supabase } from './supabase';
import { collectionEmailSource, validCollectionEmailDraft, type CollectionEmailCompletion, type CollectionEmailDraft } from './collection-email-message.mjs';

export { collectionEmailLinks, collectionEmailMessage, collectionEmailSource } from './collection-email-message.mjs';
export type { CollectionEmailCompletion, CollectionEmailDraft, CollectionEmailLinks, CollectionEmailMessage, CollectionEmailRow } from './collection-email-message.mjs';

export async function readCollectionEmailDraft(completion: CollectionEmailCompletion, signal?: AbortSignal): Promise<CollectionEmailDraft> {
  if (!supabase) throw { code: 'PGRST301' };
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(completion.requestId) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(completion.titleId)) throw new Error('invalid_collection_email_completion');
  const query = supabase.rpc('prepare_collection_customer_email', { p_finish_request_id: completion.requestId }).retry(false);
  if (signal) query.abortSignal(signal);
  const result = await query;
  if (result.error) throw result.error;
  if (!validCollectionEmailDraft(result.data, completion)) throw new Error('invalid_collection_email_draft');
  return result.data;
}

export function downloadCollectionEmail(emails: string[], subject: string, body: string): void {
  const source = collectionEmailSource(emails, subject, body);
  const url = URL.createObjectURL(new Blob([source], { type: 'message/rfc822' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cobranca-pendencias.eml';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
