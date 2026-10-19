import test from 'node:test';
import assert from 'node:assert/strict';
import { validReconciliationDate, validResolutionKey, validResolutionChoices, validReconciliationPreview } from './reconciliation.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const payment = { action: 'PAID', reason: 'Pagamento sintético conferido.', paid_on: '2026-10-19', amount_paid_cents: 1000, bank_account_id: id };
const item = changes => ({ key: `title:${id}`, kind: 'MISSING', line: null, title_id: id,
  branch: 'Filial sintética', entry_number: 'TESTE-1', description: 'Título sintético', due_date: '2026-10-18', amount_cents: 1000,
  allowed_actions: ['PAID', 'WRITE_OFF'], selected_action: 'PAID', requires_resolution: true, problem: null, ...changes });
const preview = changes => ({ mode: 'forecast', row_count: 1, reconciliation_version: '043', full_report: true,
  financial_revision: 'fixture-1', can_commit: true, reconciliation_items: [item()], resolution_errors: [], ...changes });

test('resolution decisions accept only bounded canonical identities and deliberate complete financial details', () => {
  assert(validResolutionChoices({ [`title:${id}`]: payment, 'row:1': { action: 'WRITE_OFF', reason: 'Baixa sintética confirmada.' } }, 1));
  assert(validResolutionChoices({ [`title:${id}`]: { action: 'REOPEN', reason: 'Reabertura sintética confirmada.' } }));
  assert(!validResolutionChoices({ 'row:2': { action: 'WRITE_OFF', reason: 'Baixa.' } }, 1));
  assert(validResolutionChoices({ [`title:${id}`]: { ...payment, amount_paid_cents: 1 } })); // A legacy residual still requires the SQL nominal/saldo checks.
  for (const changes of [{ amount_paid_cents: 0 }, { amount_paid_cents: 1.2 }, { bank_account_id: '' }, { bank_account_id: [id] }, { paid_on: '2026-02-30' }, { paid_on: '' }, { action: 'IGNORE' }, { reason: '' }, { reason: 'x'.repeat(1001) }, { reason: 'raw\u0000text' }, { original_rows: [] }]) {
    assert(!validResolutionChoices({ [`title:${id}`]: { ...payment, ...changes } }), JSON.stringify(Object.keys(changes)));
  }
});

test('a writeoff or reopen cannot smuggle payment facts or unknown properties', () => {
  for (const action of ['WRITE_OFF', 'REOPEN']) {
    assert(validResolutionChoices({ 'row:1': { action, reason: 'Ato sintético confirmado.' } }));
    for (const extra of [{ amount_paid_cents: 1 }, { paid_on: '2026-10-19' }, { bank_account_id: id }, { title_id: id }, { scope: 'different-scope' }]) {
      assert(!validResolutionChoices({ 'row:1': { action, reason: 'Confirmação.', ...extra } }));
    }
  }
  for (const value of [null, [], 'WRITE_OFF', { invalid: payment }, { '__proto__:x': payment }]) assert(!validResolutionChoices(value));
});

test('row identity and civil date limits reject shifted rows and invalid calendar dates', () => {
  for (const key of ['row:0', 'row:01', 'row:5001', 'row:-1', 'row:1.0', 'title:other', id]) assert(!validResolutionKey(key));
  assert(validResolutionKey('row:5000')); assert(validResolutionKey(`title:${id}`));
  assert(validReconciliationDate('2024-02-29'));
  for (const value of ['2026-02-29', '1899-12-31', '2200-01-01', '19/10/2026', '2026-10-19T00:00:00Z', null]) assert(!validReconciliationDate(value));
});

test('approved previews retain exact protocol, file type and every required disposition', () => {
  const options = { rowCount: 1, mode: 'forecast', fullReport: true, resolutionChoices: { [`title:${id}`]: payment } };
  assert(validReconciliationPreview(preview(), options));
  for (const changes of [{ reconciliation_version: '021' }, { row_count: 2 }, { mode: 'payments' }, { full_report: false }, { financial_revision: '' }, { reconciliation_items: [item(), item()] }, { reconciliation_items: [item({ selected_action: null })] }]) {
    assert(!validReconciliationPreview(preview(changes), options));
  }
  assert(validReconciliationPreview(preview({ can_commit: false, reconciliation_items: [item({ selected_action: null })] }), { ...options, resolutionChoices: {} }));
});

test('cent writeoffs never offer paid and unknown originals remain blocked without invented dates', () => {
  const options = { rowCount: 1, mode: 'payments', resolutionChoices: { 'row:1': { action:'WRITE_OFF', reason:'Baixa confirmada.' } } };
  const paid = changes => preview({ mode: 'payments', full_report: false, ...changes });
  const cent = item({ key: 'row:1', line: 1, kind: 'CENT', amount_cents: 1000, source_amount_cents: 1, allowed_actions: ['WRITE_OFF'], selected_action: 'WRITE_OFF' });
  assert(validReconciliationPreview(paid({ reconciliation_items: [cent] }), options));
  assert(!validReconciliationPreview(paid({ reconciliation_items: [{ ...cent, allowed_actions: ['PAID'], selected_action: 'PAID' }] }), options));
  const unknown = { ...cent, title_id: null, due_date: null, amount_cents: null, allowed_actions: [], selected_action: null, requires_resolution: false, problem: 'Importe primeiro a previsão do título.' };
  assert(validReconciliationPreview(paid({ can_commit: false, reconciliation_items: [unknown] }), { ...options, resolutionChoices:{} }));
  assert(!validReconciliationPreview(paid({ can_commit: true, reconciliation_items: [unknown] }), { ...options, resolutionChoices:{} }));
});

test('approval metadata cannot shift rows, invent missing titles in incremental files, or ignore submitted choices', () => {
  const options = { rowCount:1, mode:'forecast', fullReport:true, resolutionChoices:{ [`title:${id}`]:payment } };
  assert(!validReconciliationPreview(preview({ resolution_errors:[{ problem:'Pendência sintética.' }] }), options));
  assert(!validReconciliationPreview(preview({ reconciliation_items:[item({ selected_action:'WRITE_OFF' })] }), options));
  assert(!validReconciliationPreview(preview({ full_report:false }), { ...options, fullReport:false }));
  assert(!validReconciliationPreview(preview({ reconciliation_items:[item({ key:'row:1' })] }), options));
  const sourceRows = [{ branch:'Filial sintética', entry_number:'TESTE-1', amount_cents:1 }];
  const cent = item({ key:'row:1',line:1,kind:'CENT',amount_cents:1,allowed_actions:['WRITE_OFF'],selected_action:'WRITE_OFF' });
  const centOptions = { rowCount:1,mode:'forecast',fullReport:true,sourceRows,resolutionChoices:{ 'row:1':{ action:'WRITE_OFF',reason:'Confirmação.' } } };
  assert(validReconciliationPreview(preview({ reconciliation_items:[cent] }), centOptions));
  for (const changes of [{ key:'row:2' },{ line:null },{ entry_number:'OUTRO-TÍTULO' },{ branch:'Outra filial' }]) {
    assert(!validReconciliationPreview(preview({ reconciliation_items:[{ ...cent,...changes }] }), centOptions));
  }
  assert(!validReconciliationPreview(preview({ reconciliation_items:[] }), { ...centOptions,resolutionChoices:{} }));
});
