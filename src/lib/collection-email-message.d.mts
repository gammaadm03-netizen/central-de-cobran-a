export interface CollectionEmailCompletion { requestId: string; titleId: string }
export interface CollectionEmailRow { title_id: string; document: string; branch: string; due_date: string; amount_cents: number; category: 'OVERDUE' | 'UPCOMING' }
export interface CollectionEmailDraft {
  request_id: string; title_id: string; customer_key: string; client_name: string; as_of_date: string; emails: string[]; rows: CollectionEmailRow[];
  overdue_count: number; upcoming_count: number; total_count: number; overdue_cents: number; upcoming_cents: number; total_cents: number; revision: string;
}
export interface CollectionEmailMessage { subject: string; body: string }
export interface CollectionEmailLinks { gmail: string | null; outlook: string | null; mailto: string | null }
export function validCollectionEmailDraft(value: unknown, completion: CollectionEmailCompletion): value is CollectionEmailDraft;
export function collectionEmailMessage(draft: CollectionEmailDraft): CollectionEmailMessage;
export function collectionEmailLinks(emails: string[], subject: string, body: string): CollectionEmailLinks;
export function collectionEmailSource(emails: string[], subject: string, body: string): string;
