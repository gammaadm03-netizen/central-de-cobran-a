import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPendingCollectionCommissionsReport, pendingCollectionCommissionsError } from './pending-collection-commissions.ts';
const uid = 'a4700000-0000-4000-8000-000000000001';
const row = { event_id: uid, title_id: uid, document: 'NF-SINTETICA', client_name: 'Cliente sintético', branch: 'Filial sintética', due_date: '2026-09-01', nominal_reference_cents: 999999, collector_id: uid, collector_name: 'Cobradora sintética', retired_at: '2026-10-20T15:00:00+00:00', reference_date: '2026-10-20', source_import_id: uid, status: 'AWAITING_RECEIVED_REPORT', payment_date: null, commission_cents: null };
const report = () => ({ format_version: 'pending-collection-commissions-v1', count: 1, revision: '15', rows: [{ ...row }], options: { collectors: [{ id: uid, display_name: 'Cobradora sintética' }] } });
test('pending queue accepts nominal references without a fabricated payment or commission and keeps revisions opaque', () => {
  assert.equal(isPendingCollectionCommissionsReport(report()), true);
  assert.equal(isPendingCollectionCommissionsReport({ ...report(), count: 0, rows: [], options: { collectors: [] } }), true);
  for (const change of [{ payment_date: '2026-10-20' }, { commission_cents: 0 }, { status: 'ASSESSED' }, { nominal_reference_cents: 0.1 }, { nominal_reference_cents: -1 }, { nominal_reference_cents: Number.MAX_SAFE_INTEGER + 1 }, { title_id: 'invalid' }, { due_date: '2026-02-30' }]) {
    assert.equal(isPendingCollectionCommissionsReport({ ...report(), rows: [{ ...row, ...change }] }), false);
  }
});
test('pending queue refuses duplicate titles, unsafe counters, invalid options and oversized pages', () => {
  for (const change of [{ count: Number.MAX_SAFE_INTEGER + 1 }, { count: 0 }, { revision: '' }, { rows: [row, row], count: 2 }, { rows: Array.from({ length: 26 }, () => row), count: 26 }, { options: { collectors: [{ id: 'invalid', display_name: 'Cobradora sintética' }] } }, { options: { collectors: [{ id: uid, display_name: 'Cobradora sintética' }, { id: uid, display_name: 'Cobradora duplicada' }] } }]) {
    assert.equal(isPendingCollectionCommissionsReport({ ...report(), ...change }), false);
  }
});
test('pending queue errors identify its activation separately without exposing server details', () => {
  assert.match(pendingCollectionCommissionsError({ code: 'PGRST202', message: 'private detail' }), /atualização 047/);
  assert.match(pendingCollectionCommissionsError({ code: 'PGRST202' }), /apuração dos recebimentos confirmados continua disponível/);
  assert.match(pendingCollectionCommissionsError({ code: '42501' }), /Seu acesso/);
  assert.doesNotMatch(pendingCollectionCommissionsError({ message: 'private detail' }), /private detail/);
});
