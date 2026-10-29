import { readFile } from 'node:fs/promises';

export const RECEIVABLE_REVERSAL_CONSUMER_SIGNATURES = [
  'cf_private.close_settled_collection_work()',
  'cf_private.collection_workbench_row(public.receivable_titles,timestamp with time zone)',
  'cf_private.collection_workflow_collectible(public.receivable_titles)',
  'cf_private.receivable_import_collector_plan(jsonb,jsonb)',
  'cf_private.record_receivable_report_event(uuid,text,uuid,uuid,date)',
  'cf_private.resolve_receivable_sync_rows(text,jsonb,jsonb,text)',
  'public.collection_workbench(text,uuid,boolean,text,text,text,integer,integer,text,date,date,text,text)',
  'public.commit_receivables_open_import_with_collectors_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb)',
  'public.commit_receivables_open_report_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,uuid,text,jsonb,boolean,date,uuid)',
  'public.pending_collection_commissions(text,uuid,integer,integer)',
  'public.prepare_collection_customer_email(uuid)',
  'public.preview_receivables_open_report(text,jsonb,boolean,date,jsonb,jsonb)',
  'public.receivable_retired_validation_queue(text,uuid,integer,integer)',
  'public.save_collection_case(uuid,text,text,text,date,bigint,bigint,date,boolean,uuid)',
  'public.validate_receivable_payment_v2(uuid,text,date,bigint,text,text,bigint,uuid)',
];

export async function buildReceivableReversalConsumersSql() {
  const sql = await readFile(new URL('../supabase/fragments/receivable-reversal-consumers.sql', import.meta.url), 'utf8');
  for (const signature of RECEIVABLE_REVERSAL_CONSUMER_SIGNATURES) {
    if (!sql.includes("'" + signature + "'")) throw new Error('Missing receivable reversal consumer ' + signature);
  }
  return sql;
}
