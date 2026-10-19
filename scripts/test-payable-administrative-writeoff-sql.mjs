import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildPayableAdministrativeWriteoffSql } from './bundle-payable-administrative-writeoff.mjs';

// Disposable PostgreSQL. No employee, customer, source file or production ID.
const db = new PGlite();
const uid = i => `42000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const sid = i => `42000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
const roles = ['gerente_geral', 'contas_pagar', 'contas_pagar', 'diretor', 'contas_receber', 'rh_dp'];
const migration = await buildPayableAdministrativeWriteoffSql();
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.r;
const owner = async (i = 1, extra = {}, session = sid(i)) => {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [uid(i), JSON.stringify({ sub: uid(i), session_id: session, ...extra })]);
};
const actor = async (i = 1, extra = {}, session = sid(i)) => { await owner(i, extra, session); await db.exec('SET ROLE authenticated'); };
const rejects = (sql, args = [], code = '42501') => assert.rejects(db.query(sql, args), error => { assert.equal(error.code, code, error.message); return true; });
const all = async table => (await db.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.r);
const title = entry => scalar('SELECT to_jsonb(t) r FROM public.payable_review_titles t WHERE entry_number=$1', [entry]);
const writeoff = (t, reason = 'Baixa individual explicitamente confirmada no teste', source = null, revision = t.payment_revision) => scalar('SELECT cf_private.record_payable_administrative_writeoff($1,$2,$3,$4) r', [t.id, source, reason, revision]);
const reverse = (t, reason = 'Reabertura individual explicitamente confirmada no teste', revision = t.payment_revision) => scalar('SELECT cf_private.reverse_payable_administrative_writeoff($1,$2,$3) r', [t.id, reason, revision]);
const payment = (t, amount = t.amount_cents, request = randomUUID()) => scalar('SELECT public.register_payable_payment($1,$2,$3,$4,$5,$6,$7,$8) r', [t.id, amount, today, bank, 'Pagamento real sintético confirmado', t.payment_revision, request, t.last_import_id]);
let passed = 0, seq = 0, latest = null, today, week, month, nextMonth, previousMonth, bank, initialRows, historicalPayment, historicalRequest, historicalTitle;
let preActivationReviewed, preActivationClosure, preActivationMonthStatus;
const test = async (name, run) => { await run(); passed++; console.log('PASS', name); };
const forecast = async (rows, sourceNumber = ++seq) => {
  const bytes = Buffer.from(`Arquivo sintético de previsão ${sourceNumber}`);
  await owner(1); await db.exec('SET ROLE service_role');
  try {
    const result = await scalar('SELECT public.commit_payables_forecast_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [uid(1), sid(1), 'grupo-consolidado', `sintetico-${sourceNumber}.csv`, createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), JSON.stringify(rows), JSON.stringify({ 'MERCADORIA TESTE': 'COMPRA DE MERCADORIA', 'FIXO TESTE': 'FIXO', 'SALARIO SENTINELA': 'SALÁRIOS' }), latest]);
    latest = result.import_id; return result;
  } finally { await actor(1); }
};
const columns = table => scalar("SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod) ORDER BY attnum) r FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped", [table]);
const protectedTables = ['public.profiles', 'public.role_permissions', 'public.payable_titles', 'public.payable_imports', 'cf_private.payable_import_files', 'public.payable_payments', 'public.payable_payment_reversals', 'public.payable_month_closures', 'public.payable_month_events', 'public.audit_events'];
const snapshot = async () => Object.fromEntries(await Promise.all(protectedTables.map(async table => [table, await all(table)])));

try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  await test('042 rejects an incomplete financial base atomically', async () => {
    await assert.rejects(db.exec(migration), error => error.code === '22023'); await db.exec('ROLLBACK');
    assert.equal(await scalar("SELECT to_regclass('public.payable_administrative_writeoffs')::text r"), null);
  });
  for (const name of ['001_identidade_rbac.sql', '003_auth_gateway.sql', '005_payables.sql', '006_treasury.sql', '007_director_positions.sql', '008_receivables.sql', '009_collections.sql', '010_bank_import.sql', '011_receivables_positions.sql', '012_treasury_accounts.sql', '013_director_report.sql', '014_payables_forecast.sql', '015_payable_payments.sql', '016_payable_identity_updates.sql', '017_payable_month_closing.sql', '018_payable_full_payment.sql', '019_payable_cheques.sql', '020_payables_management.sql', '021_payable_paid_import.sql', '031_director_readonly.sql', '039_user_access_limits.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const [index, role] of roles.entries()) {
    const i = index + 1;
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [uid(i), `synthetic-writeoff-${i}@example.invalid`]);
    await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)', [uid(i), `SyntheticWriteoff${i}`, role]);
    await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [sid(i), uid(i)]);
  }
  ({ today, week, month, next_month: nextMonth, previous_month: previousMonth } = (await db.query(`SELECT (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text today,
    ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-((extract(dow FROM statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::integer+1)%7))::text week,
    date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS "month",
    (date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month')::date::text next_month,
    (date_trunc('month',statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')-interval '1 month')::date::text previous_month`)).rows[0]);
  await actor(1); bank = await scalar('SELECT id r FROM public.bank_accounts WHERE enabled ORDER BY id LIMIT 1');
  const row = (entry_number, amount_cents, plan = 'FIXO TESTE', due_date = today) => ({ entry_number, amount_cents, plan, due_date, description: 'Fornecedor sintético', branch: 'FILIAL TESTE', source_status: 'ABERTO', bank_account: 'ORIGEM SINTETICA' });
  initialRows = [row('CENT', 1, 'MERCADORIA TESTE'), row('MISSING', 10000, 'MERCADORIA TESTE'), row('NORMAL', 20000), row('PAID', 1000), row('PARTIAL', 2000), row('OVERPAID', 3000), row('OLD_CENT', 1), row('UNCONFIRMED_CENT', 1), row('SALARY_CENT', 1, 'SALARIO SENTINELA', nextMonth.slice(0, 8) + '05'), row('CLOSING_PAID', 1000, 'FIXO TESTE', nextMonth.slice(0, 8) + '10'), row('CLOSING_ADMIN', 500, 'FIXO TESTE', nextMonth.slice(0, 8) + '11'), row('PRE042_CLOSED', 2000, 'FIXO TESTE', previousMonth.slice(0, 8) + '15')];
  await forecast(initialRows);
  historicalTitle = await title('OLD_CENT'); historicalRequest = randomUUID(); historicalPayment = await payment(historicalTitle, 1, historicalRequest);
  for (const entry of ['PAID', 'PARTIAL', 'OVERPAID', 'CLOSING_PAID', 'PRE042_CLOSED']) await payment(await title(entry));
  const oldClosedTitle = await title('PRE042_CLOSED');
  await scalar('SELECT public.review_payable_title($1,$2,$3) r', [oldClosedTitle.id, 'Conferência genuína antes da atualização042', oldClosedTitle.review_fingerprint]);
  preActivationReviewed = await title('PRE042_CLOSED');
  const oldMonthStatus = await scalar('SELECT public.payables_month_status($1) r', [previousMonth]);
  const oldClosureId = await scalar('SELECT public.close_payables_month($1,$2,$3) r', [previousMonth, 'Fechamento genuíno antes da atualização042', oldMonthStatus.revision]);
  preActivationClosure = await scalar('SELECT to_jsonb(c) r FROM public.payable_month_closures c WHERE id=$1', [oldClosureId]);
  preActivationMonthStatus = await scalar('SELECT public.payables_month_status($1) r', [previousMonth]);
  await owner(1);
  await db.query("UPDATE public.payable_titles SET amount_cents=CASE entry_number WHEN 'PARTIAL' THEN 2001 ELSE 1000 END WHERE entry_number IN('PARTIAL','OVERPAID')");
  await db.query("INSERT INTO public.bank_balance_positions(account_id,balance_date,amount_cents,observation,created_by) SELECT id,$1,100000,'Posição sintética',$2 FROM public.bank_accounts WHERE enabled", [today, uid(1)]);
  await db.query("INSERT INTO public.stock_positions(value_cents,reference_date,observation,created_by) VALUES(1000000,$1,'Estoque sintético',$2)", [today, uid(1)]);
  await scalar('SELECT public.save_director_inputs($1,$2,$3,null) r', [today, JSON.stringify({ turnover_month_cents: 10000, turnover_comlurb_cents: 0, orders_cents: 10000, blocked_orders_cents: 0, pending_orders_cents: 0, overdue_comlurb_cents: 0, installments_cents: 1000, previous_month_taxes_cents: 1000 }), 'Complementos sintéticos']);
  const crBytes = Buffer.from('Arquivo sintético de recebíveis');
  await db.exec('SET ROLE service_role');
  await scalar('SELECT public.commit_receivables_import_from_gateway($1,$2,$3,$4,$5,$6,$7,true,null) r', [uid(1), sid(1), 'grupo-consolidado', 'recebiveis-sinteticos.csv', createHash('sha256').update(crBytes).digest('hex'), crBytes.toString('base64'), JSON.stringify([{ document: 'CR-SINTETICO', client_name: 'Cliente sintético', branch: 'FILIAL TESTE', due_date: today, amount_cents: 100000 }])]);
  await owner(1);
  preActivationMonthStatus = await scalar('SELECT public.payables_month_status($1) r', [previousMonth]);
  const before = await snapshot(), financialColumns = await columns('public.payable_financial_titles'), reviewColumns = await columns('public.payable_review_titles');
  await db.exec(migration);

  await test('activation preserves financial data, source files, profiles, permissions and historical cash', async () => {
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await columns('public.payable_financial_titles')).slice(0, financialColumns.length), financialColumns);
    assert.deepEqual((await columns('public.payable_review_titles')).slice(0, reviewColumns.length), reviewColumns);
    assert.equal(await scalar("SELECT count(*)::int r FROM public.payable_administrative_writeoffs"), 0);
    assert.equal((await title('CENT')).financial_status, 'OPEN');
    assert.equal((await title('CENT')).outstanding_cents, 1);
  });
  await test('activation preserves pre-existing review fingerprints, genuine conciliation and closed months', async () => {
    const after = await title('PRE042_CLOSED');
    assert.equal(preActivationReviewed.review_status, 'CONCILIADO');
    assert.equal(after.review_fingerprint, preActivationReviewed.review_fingerprint);
    assert.equal(after.review_status, 'CONCILIADO');
    assert.equal(after.review_id, preActivationReviewed.review_id);
    assert.deepEqual(await scalar('SELECT to_jsonb(c) r FROM public.payable_month_closures c WHERE id=$1', [preActivationClosure.id]), preActivationClosure);
    assert.deepEqual(await scalar('SELECT public.payables_month_status($1) r', [previousMonth]), preActivationMonthStatus);
  });
  await test('private mutators and active history have no direct API grants', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await owner(1); await db.exec(`SET ROLE ${role}`);
      await rejects('SELECT cf_private.record_payable_administrative_writeoff($1,null,$2,null)', [historicalTitle.id, 'Tentativa direta']);
      await rejects('SELECT cf_private.reverse_payable_administrative_writeoff($1,$2,null)', [historicalTitle.id, 'Tentativa direta']);
      await rejects('SELECT * FROM cf_private.active_payable_administrative_writeoffs');
    }
  });
  await test('Director, CR, RH, disabled, expired and forged-role sessions cannot write off through a trusted caller', async () => {
    await owner(1); const normalId = (await title('NORMAL')).id;
    for (const i of [4, 5, 6]) { await owner(i, { role: 'admin', role_key: 'gerente_geral' }); await rejects('SELECT cf_private.record_payable_administrative_writeoff($1,null,$2,null)', [normalId, 'Tentativa sem permissão']); }
    await owner(1); await db.query('UPDATE public.profiles SET enabled=false WHERE id=$1', [uid(2)]); await owner(2);
    await rejects('SELECT cf_private.record_payable_administrative_writeoff($1,null,$2,null)', [normalId, 'Usuário bloqueado']);
    await owner(1); await db.query('UPDATE public.profiles SET enabled=true WHERE id=$1', [uid(2)]); await owner(2, {}, null);
    await rejects('SELECT cf_private.record_payable_administrative_writeoff($1,null,$2,null)', [normalId, 'Sessão ausente']);
    await owner(1); await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [sid(2)]); await owner(2);
    await rejects('SELECT cf_private.record_payable_administrative_writeoff($1,null,$2,null)', [normalId, 'Sessão expirada']);
    await owner(1); await db.query("UPDATE cf_private.approved_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE session_id=$1", [sid(2)]);
  });
  let centEvent, missingEvent, centRevision;
  const beforeSummary = await scalar('SELECT public.payables_summary($1,$2) r', [week, today]);
  const beforeManagement = await scalar('SELECT public.payables_management_summary($1,null) r', [week]);
  const beforeDirector = await scalar('SELECT public.director_report($1,$2) r', [week, today]);
  await test('an individual one-cent confirmation records administrative history without any payment', async () => {
    await owner(1); const t = await title('CENT'); centRevision = t.payment_revision;
    const cashBefore = await all('public.payable_payments'); centEvent = await writeoff(t, 'Valor de R$ 0,01 confirmado como baixa sem pagamento', latest);
    const after = await title('CENT');
    assert.equal(after.amount_cents, 1); assert.equal(after.paid_cents, 0); assert.equal(after.outstanding_cents, 0); assert.equal(after.payment_remaining_cents, 0);
    assert.equal(after.financial_status, 'ADMIN_WRITEOFF'); assert.equal(after.review_status, 'BAIXADO_ADMINISTRATIVAMENTE');
    assert.equal(after.closing_eligible, false); assert.equal(after.closing_exclusion_reason, 'ADMIN_WRITEOFF');
    assert.equal(after.administrative_writeoff_id, centEvent.event_id); assert.equal(after.administrative_writeoff_import_id, latest);
    assert.notEqual(after.payment_revision, t.payment_revision); assert.notEqual(after.review_fingerprint, t.review_fingerprint);
    assert.deepEqual(await all('public.payable_payments'), cashBefore);
  });
  await test('a missing title of any nominal amount can be written off explicitly without inventing cash', async () => {
    await owner(1); missingEvent = await writeoff(await title('MISSING'), 'Ausência conferida: somente baixado, sem pagamento', latest);
    const t = await title('MISSING'); assert.equal(t.amount_cents, 10000); assert.equal(t.paid_cents, 0); assert.equal(t.outstanding_cents, 0);
  });
  await test('CP, Painel, Director merchandise, future and macro aggregates exclude active administrative writeoffs', async () => {
    await actor(1);
    const summary = await scalar('SELECT public.payables_summary($1,$2) r', [week, today]);
    const management = await scalar('SELECT public.payables_management_summary($1,null) r', [week]);
    const director = await scalar('SELECT public.director_report($1,$2) r', [week, today]);
    assert.equal(beforeSummary.period_cents - summary.period_cents, 10001);
    assert.equal(beforeManagement.planned_week_cents - management.planned_week_cents, 10001);
    assert.equal(beforeManagement.open_week_cents - management.open_week_cents, 10001);
    assert.equal(beforeDirector.indicators.merchandise_cents - director.indicators.merchandise_cents, 10001);
    assert.equal(await scalar('SELECT (($2::numeric-$1::numeric)*100000000)::integer r', [beforeDirector.indicators.current_assets_millions, director.indicators.current_assets_millions]), 10001);
    assert.equal(director.indicators.projected_cash_cents - beforeDirector.indicators.projected_cash_cents, 10001);
    assert.equal(management.by_macro.find(m => m.macro === 'COMPRA DE MERCADORIA').planned_cents, 0);
    assert.equal(await scalar("SELECT coalesce(sum(amount_cents),0)::int r FROM public.payable_review_titles WHERE closing_eligible AND macro='COMPRA DE MERCADORIA'"), 0);
  });
  await test('written-off salary titles cannot affect actual provision totals or missing-plan warnings', async () => {
    await owner(1);
    assert.ok((await scalar("SELECT cf_private.payable_forecast_provision('SALARIOS',$1,true) r", [nextMonth])).issues.length > 0);
    await writeoff(await title('SALARY_CENT'), 'Sentinela de salário conferido sem pagamento', latest);
    const provision = await scalar("SELECT cf_private.payable_forecast_provision('SALARIOS',$1,true) r", [nextMonth]);
    assert.equal(provision.actual_cents, 0); assert.deepEqual(provision.issues, []);
    const forecast = await scalar('SELECT public.payables_forecast($1) r', [week]);
    assert.equal(forecast.weeks.reduce((sum, w) => sum + w.real_cents, 0), await scalar('SELECT coalesce(sum(outstanding_cents),0)::integer r FROM public.payable_financial_titles WHERE due_date BETWEEN $1::date AND $1::date+55', [week]));
  });
  await test('active paid, partial and overpaid obligations cannot receive an administrative writeoff', async () => {
    await owner(1);
    for (const entry of ['PAID', 'PARTIAL', 'OVERPAID', 'OLD_CENT']) await assert.rejects(writeoff(await title(entry)), error => error.code === 'P0042');
  });
  await test('all new payment writers reject one-cent and written-off titles while genuine historical replays survive', async () => {
    await actor(1);
    assert.equal(await payment(historicalTitle, 1, historicalRequest), historicalPayment);
    await assert.rejects(payment(await title('UNCONFIRMED_CENT'), 1), error => error.code === 'P0042');
    await assert.rejects(payment(await title('CENT'), 1), error => error.code === 'P0042');
    await assert.rejects(payment(await title('MISSING'), 10000), error => error.code === 'P0042');
    await owner(1);
    await rejects("UPDATE public.payable_titles SET amount_cents=1 WHERE entry_number='PAID'", [], 'P0042');
  });
  await test('a genuine old partial payment can receive its exact one-cent residual when the nominal amount exceeds one cent', async () => {
    await actor(1); const t = await title('PARTIAL');
    assert.equal(t.amount_cents, 2001); assert.equal(t.paid_cents, 2000); assert.equal(t.payment_remaining_cents, 1);
    const id = await payment(t, 1); const after = await title('PARTIAL');
    assert.ok(id); assert.equal(after.financial_status, 'PAID'); assert.equal(after.paid_cents, 2001);
    assert.equal(after.administrative_writeoff_id, null);
  });
  await test('old forecast recurrence preserves the administrative state and rejects real-value changes atomically', async () => {
    const changed = initialRows.map(r => r.entry_number === 'CENT' ? { ...r, amount_cents: 5000 } : r);
    await owner(1); const importsBefore = await all('public.payable_imports');
    await assert.rejects(forecast(changed), error => error.code === 'P0042');
    await owner(1); assert.deepEqual(await all('public.payable_imports'), importsBefore);
    // Keep the pre-existing partial/overpaid corrections unchanged in this test.
    const repeat = initialRows.map(r => r.entry_number === 'PARTIAL' ? { ...r, amount_cents: 2001 } : r.entry_number === 'OVERPAID' ? { ...r, amount_cents: 1000 } : r);
    await forecast(repeat);
    assert.equal((await title('CENT')).administrative_writeoff_id, centEvent.event_id);
    assert.equal((await title('MISSING')).administrative_writeoff_id, missingEvent.event_id);
    assert.equal((await title('CENT')).outstanding_cents, 0);
  });
  await test('reconfirming an active administrative state cannot create a second active event', async () => {
    await owner(1); const before = await all('public.payable_administrative_writeoffs');
    await assert.rejects(writeoff(await title('CENT')), error => error.code === '22023');
    assert.deepEqual(await all('public.payable_administrative_writeoffs'), before);
  });
  await test('reasons are mandatory and stale reopens preserve all history', async () => {
    await owner(1); await assert.rejects(writeoff(await title('NORMAL'), ''), error => error.code === '22023');
    await assert.rejects(reverse(await title('CENT'), 'Reabertura desatualizada', centRevision), error => error.code === '40001');
    assert.equal((await title('CENT')).administrative_writeoff_id, centEvent.event_id);
  });
  await test('explicit reopens are audited, permit later real-value correction and can be performed by another CP operator', async () => {
    await owner(2); const t = await title('CENT'); const reopened = await reverse(t);
    assert.equal(reopened.writeoff_id, centEvent.event_id); assert.equal((await title('CENT')).outstanding_cents, 1);
    await db.query("UPDATE public.payable_titles SET amount_cents=5000 WHERE entry_number='CENT'");
    assert.equal((await title('CENT')).outstanding_cents, 5000);
    assert.equal((await title('CENT')).administrative_writeoff_id, null);
    assert.equal(await scalar("SELECT count(*)::int r FROM public.audit_events WHERE entity='payable_administrative_writeoffs' AND action='REOPEN'"), 1);
  });
  await test('a limited CP user retains exactly the authorized modules and can confirm a writeoff', async () => {
    await owner(1); await scalar('SELECT cf_private.restrict_payables_user($1) r', [uid(2)]);
    await owner(2); const event = await writeoff(await title('NORMAL'));
    await actor(2); assert.equal((await title('NORMAL')).administrative_writeoff_id, event.event_id);
    assert.equal(await scalar("SELECT cf_private.has_permission('caixa','read') r"), false);
    assert.equal(await scalar("SELECT cf_private.has_permission('contas_pagar','write') AND cf_private.has_permission('contas_pagar','import') r"), true);
  });
  await test('closing excludes writeoffs without fake conciliation, preserves its snapshot and reopens after a reversal', async () => {
    await owner(1); await writeoff(await title('CLOSING_ADMIN'), 'Baixa individual no mês sintético de fechamento', latest);
    const paid = await title('CLOSING_PAID');
    await scalar('SELECT public.review_payable_title($1,$2,$3) r', [paid.id, 'Pagamento integral conferido', paid.review_fingerprint]);
    const status = await scalar('SELECT public.payables_month_status($1) r', [nextMonth]);
    assert.equal(status.total_titles, 1); assert.equal(status.excluded_historical_count, 2); assert.equal(status.can_close, true);
    const closure = await scalar('SELECT public.close_payables_month($1,$2,$3) r', [nextMonth, 'Fechamento sintético', status.revision]);
    const snapshot = await scalar('SELECT to_jsonb(c) r FROM public.payable_month_closures c WHERE id=$1', [closure]);
    assert.equal(snapshot.total_nominal_cents, 1000);
    assert.equal(snapshot.snapshot.historical_titles.every(t => t.review_status === 'BAIXADO_ADMINISTRATIVAMENTE'), true);
    await reverse(await title('CLOSING_ADMIN'));
    assert.deepEqual(await scalar('SELECT to_jsonb(c) r FROM public.payable_month_closures c WHERE id=$1', [closure]), snapshot);
    assert.equal(await scalar("SELECT action r FROM public.payable_month_events WHERE closure_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [closure]), 'REOPEN');
  });
  await test('ledger read policies do not expose CP data to CR or RH through Painel permissions', async () => {
    for (const i of [5, 6]) { await actor(i); assert.equal(await scalar('SELECT count(*)::int r FROM public.payable_administrative_writeoffs'), 0); }
    await actor(4); assert.ok(await scalar('SELECT count(*)::int r FROM public.payable_administrative_writeoffs') > 0);
    await rejects('INSERT INTO public.payable_administrative_writeoffs(title_id,event_type,title_amount_cents,reason,created_by) VALUES($1,\'WRITE_OFF\',1,\'Diretoria\',$2)', [historicalTitle.id, uid(4)]);
  });
  await test('administrative history is immutable even for trusted SQL writers and generates no fictitious financial entry', async () => {
    await owner(1);
    await rejects('UPDATE public.payable_administrative_writeoffs SET reason=$1 WHERE id=$2', ['Reescrita proibida', centEvent.event_id]);
    await rejects('DELETE FROM public.payable_administrative_writeoffs WHERE id=$1', [centEvent.event_id]);
    assert.equal((await all('public.payable_payments')).length, 7);
    assert.equal((await all('public.payable_payment_reversals')).length, 0);
    assert.equal((await scalar('SELECT to_jsonb(p) r FROM public.payable_payments p WHERE id=$1', [historicalPayment])).amount_cents, 1);
  });
  await test('reapplying activation preserves events, revisions, permissions and previously installed caps', async () => {
    await owner(1); const before = await snapshot(), events = await all('public.payable_administrative_writeoffs'), limits = await all('cf_private.user_access_limits');
    const revisions = await all('public.payable_title_control_revisions');
    await db.exec(migration);
    assert.deepEqual(await snapshot(), before); assert.deepEqual(await all('public.payable_administrative_writeoffs'), events);
    assert.deepEqual(await all('public.payable_title_control_revisions'), revisions); assert.deepEqual(await all('cf_private.user_access_limits'), limits);
    assert.equal(await scalar("SELECT count(*)::int r FROM public.central_schema_migrations WHERE version='042_payable_administrative_writeoff'"), 1);
    assert.equal(await readFile(new URL('../supabase/dashboard/ativar-baixas-administrativas-cp.sql', import.meta.url), 'utf8'), migration);
  });
  console.log(`Passed ${passed} administrative writeoff SQL tests.`);
} finally { await db.close(); }
