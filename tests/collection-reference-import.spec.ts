import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';

// All workbooks, people and addresses below are synthetic. Never load customer attachments.
const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
const id = (n: number) => '98000000-0000-4000-8000-' + String(n).padStart(12, '0');
const fixed = new Date('2026-10-18T15:00:00Z');
const contactHeaders = ['Entidade: nome', 'Endereço: email', 'T. 1: ddd', 'T. 1: número'];
const descriptionHeaders = ['CLIENTE', 'CONTRATO', 'NOTA FISCAL', 'DESCRIÇÃO', 'FILIAL'];
type Mode = 'contacts' | 'descriptions';
async function workbook(mode: Mode = 'contacts', quantity = 3) {
  const matrix: string[][] = [mode === 'contacts' ? contactHeaders : descriptionHeaders];
  for (let n = 1; n <= quantity; n++) matrix.push(mode === 'contacts'
    ? ['Cliente sintético para importação de contatos ' + n + ' ' + 'c'.repeat(150), 'synthetic' + n + '@example.invalid', '', '']
    : ['Cliente sintético ' + n, n % 2 ? '' : 'Contrato sintético', '000' + n, 'Descrição sintética ' + n, '37']);
  const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const rows = matrix.map((row, index) => '<row r="' + (index + 1) + '">' + row.map((value, column) => '<c r="' + String.fromCharCode(65 + column) + (index + 1) + '" t="inlineStr"><is><t>' + xml(value) + '</t></is></c>').join('') + '</row>').join('');
  const strToU8 = (value: string) => Buffer.from(value, 'utf8');
  const parts = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Base sintética" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows + '</sheetData></worksheet>'),
  };
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(parts)) zip.file(name, bytes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}
interface Options {
  role?: string; missingWrite?: boolean; warning?: boolean; lostStageAck?: boolean; holdFirstStage?: boolean;
  lostPublishAck?: boolean; stalePublish?: boolean; existingPublished?: boolean; existingUnverified?: boolean;
  badSource?: boolean; activationMissing?: boolean; previewFailureOnce?: '57014' | '55P03'; previewFailureOnAttempt?: number; malformedPreviewOnce?: boolean;
}
async function setup(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(fixed);
  const role = options.role ?? 'contas_receber';
  const permissions = [{ resource: 'importar_bases', action: 'read' }, { resource: 'contas_receber', action: 'read' }, { resource: 'contas_receber', action: 'import' }, ...(!options.missingWrite ? [{ resource: 'contas_receber', action: 'write' }] : [])];
  const access = { profile: { id: id(1), username: 'TesteReferencias', display_name: 'Pessoa sintética', role_key: role, enabled: true }, permissions, collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: fixed.getTime() / 1000 + 3600, role: 'authenticated' })).toString('base64url'), 'synthetic-test-only'].join('.');
  const calls: { action: string; body: any; url: string; authorization: string }[] = [], uploads: { url: string; headers: Record<string, string> }[] = [];
  const staged = new Map<number, { hash: string; count: number }>(), published = new Map<string, any>();
  let job: any = null, originalStored = !!options.existingUnverified, stageFailure = !!options.lostStageAck, publishFailure = !!options.lostPublishAck, stale = !!options.stalePublish;
  let previewFailure = options.previewFailureOnce, previewAttempts = 0, malformedPreview = !!options.malformedPreviewOnce;
  let release!: () => void; const stageHold = new Promise<void>(resolve => { release = resolve; }); let stageWasHeld = false;
  const preview = () => ({
    job_id: job.job_id, mode: job.mode, status: job.status, financial_revision: stale ? 'financial-1' : 'financial-2', context_revision: 'reference-1',
    source: { name: job.source_name, size: job.source_size, sha256: job.source_sha256, verified: true }, manifest_sha256: 'b'.repeat(64),
    row_count: job.staged_rows, deduplicated_count: 0, eligible_count: options.warning ? Math.max(0, job.staged_rows - 1) : job.staged_rows,
    matched_title_count: job.staged_rows, unmatched_count: options.warning ? 1 : 0, paid_only_count: 0, ambiguous_count: 0, invalid_count: options.warning ? 1 : 0,
    warning_count: options.warning ? 1 : 0, manual_preserved_count: 1, variant_count: 0, quarantine_count: options.warning ? 1 : 0, can_publish: true, requires_quarantine_confirmation: !!options.warning,
    processed_rows: 0, published_rows: 0, remaining_rows: job.staged_rows,
    examples: options.warning ? [{ source_line: 2, outcome: 'INVALID', client_name: null, problem: 'Identificação ausente. Registro preservado para conferência.' }] : [],
  });
  await page.route(project + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'apikey,authorization,content-type,x-client-info,x-upsert,cache-control', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname.startsWith('/storage/v1/object/')) { uploads.push({ url: url.pathname, headers: request.headers() }); originalStored = true; return reply({ Key: 'collection-reference-files/' + id(1) + '/' + id(10) + '/original', Id: id(70) }); }
    const body = request.postDataJSON();
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id: id(1), aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', created_at: fixed.toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (['/rest/v1/receivable_titles', '/rest/v1/collection_agents', '/rest/v1/receivable_imports'].includes(url.pathname)) return route.fulfill({ status: 200, headers: { ...headers, 'content-range': '*/0' }, json: [] });
    if (url.pathname !== '/functions/v1/collection-reference-import') throw new Error('Unexpected offline reference request ' + url.pathname);
    calls.push({ action: body.action, body, url: url.pathname, authorization: request.headers().authorization ?? '' });
    if (options.activationMissing) return reply({ code: 'P0028', activation_required: true, error: 'private SQL relation details' }, 409);
    if (body.action === 'history') return reply({ count: job ? 1 : 0, rows: job ? [job] : [] });
    if (body.action === 'begin') {
      const reused = job !== null;
      if (!job) job = { job_id: id(10), mode: body.mode === 'contacts' ? 'CONTACTS' : 'DESCRIPTIONS', status: options.existingPublished ? 'PUBLISHED' : 'UPLOADING', bucket: 'collection-reference-files', storage_path: id(1) + '/' + id(10) + '/original', source_name: body.file_name, source_size: body.file_size, source_sha256: body.file_sha256, original_verified: !!options.existingPublished, manifest_sha256: options.existingPublished ? 'b'.repeat(64) : null, staged_rows: options.existingPublished ? 3 : 0, staged_chunks: options.existingPublished ? 1 : 0, created_at: fixed.toISOString() };
      return reply({ ...job, reused: reused || !!options.existingPublished || !!options.existingUnverified });
    }
    if (body.action === 'status') return reply(job);
    if (body.action === 'verify_original') {
      if (!originalStored) return reply({ code: 'ORIGINAL_MISSING', error: 'Envie a cópia original.' }, 409);
      if (options.badSource) return reply({ code: '23514', error: 'private storage metadata' }, 409);
      job.original_verified = true; job.status = 'VERIFIED'; return reply(job);
    }
    if (body.action === 'stage') {
      const raw = Buffer.from(body.chunk_base64, 'base64'), hash = createHash('sha256').update(raw).digest('hex');
      expect(hash).toBe(body.chunk_sha256); expect(raw.length).toBeLessThanOrEqual(256 * 1024);
      const rows = raw.toString('utf8').trimEnd().split(/\r?\n/).length - 1, previous = staged.get(body.chunk_index);
      expect(rows).toBeGreaterThan(0); expect(rows).toBeLessThanOrEqual(500); if (previous) expect(previous.hash).toBe(hash);
      staged.set(body.chunk_index, { hash, count: rows }); job.status = 'STAGING'; job.staged_chunks = staged.size; job.staged_rows = [...staged.values()].reduce((sum, part) => sum + part.count, 0);
      if (options.holdFirstStage && !stageWasHeld) { stageWasHeld = true; await stageHold; }
      if (stageFailure) { stageFailure = false; return reply({ error: 'private upstream timeout' }, 503); }
      return reply({ job_id: job.job_id, chunk_index: body.chunk_index, row_count: rows, duplicate: !!previous, staged_rows: job.staged_rows, staged_chunks: job.staged_chunks });
    }
    if (body.action === 'finish_prepare') { expect(body.expected_chunks).toBe(staged.size); job.status = 'PREPARED'; job.manifest_sha256 = 'b'.repeat(64); return reply(job); }
    if (body.action === 'preview') {
      previewAttempts++;
      if (previewFailure && previewAttempts === (options.previewFailureOnAttempt ?? 1)) {
        const code = previewFailure; previewFailure = undefined;
        return reply({ code, error: 'private SQL details must never reach the screen', schema_version: 'collection-reference-import/2026-10-27.1', diagnostic: { request_id: id(90), phase: 'preview' } }, code === '57014' ? 504 : 409);
      }
      if (malformedPreview) { malformedPreview = false; return reply({ ...preview(), row_count: String(job.staged_rows) }); }
      return reply(preview());
    }
    if (body.action === 'publish') {
      if (published.has(body.request_id)) return reply(published.get(body.request_id));
      if (stale) { stale = false; return reply({ code: '40001', error: 'private SQL revision details' }, 409); }
      job.status = 'PUBLISHED';
      const result = { job_id: job.job_id, status: 'PUBLISHED', done: true, processed_rows: job.staged_rows, published_rows: options.warning ? Math.max(0, job.staged_rows - 1) : job.staged_rows, skipped_manual_rows: 1, quarantined_rows: options.warning ? 1 : 0, remaining_rows: 0 };
      published.set(body.request_id, result);
      if (publishFailure) { publishFailure = false; return reply({ error: 'private response lost' }, 503); }
      return reply(result);
    }
    throw new Error('Unexpected reference action ' + body.action);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('TesteReferencias'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  if (role !== 'diretor') await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click();
  return { calls, uploads, staged, published, releaseStage: release, job: () => job };
}
async function openReferences(page: Page) { await page.getByRole('tab', { name: 'Contatos e descrições', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Contatos e descrições da Cobrança' })).toBeVisible(); }
async function prepare(page: Page, mode: Mode = 'contacts', quantity = 3) {
  if (mode === 'descriptions') await page.getByRole('button', { name: /^Descrições dos títulos/ }).click();
  const bytes = await workbook(mode, quantity), name = mode === 'contacts' ? 'contatos-sinteticos.xlsx' : 'descricoes-sinteticas.xlsx';
  await page.locator('#collection-reference-file').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes }); await page.getByRole('button', { name: 'Preparar e conferir arquivo', exact: true }).click();
  return bytes;
}

test('prepares a large workbook in private authenticated bounded chunks and retries a lost stage acknowledgement without duplication', async ({ page }) => {
  test.setTimeout(60000);
  const seen = await setup(page, { lostStageAck: true }); await openReferences(page); const bytes = await prepare(page, 'contacts', 5101);
  expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024); await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible({ timeout: 45000 });
  expect(seen.uploads).toHaveLength(1); expect(seen.uploads[0].url).toBe('/storage/v1/object/collection-reference-files/' + id(1) + '/' + id(10) + '/original'); expect(seen.uploads[0].headers.authorization).toContain('Bearer ');
  expect(seen.uploads[0].headers['x-upsert']).toBe('false'); expect(seen.staged.size).toBe(11); expect(seen.job().staged_rows).toBe(5101);
  const attempts = seen.calls.filter(call => call.action === 'stage'); expect(attempts[0].body).toEqual(attempts[1].body);
  for (const call of attempts) expect(Object.keys(call.body).sort()).toEqual(['action', 'chunk_base64', 'chunk_index', 'chunk_sha256', 'job_id']);
  expect(seen.calls.every(call => call.authorization.startsWith('Bearer '))).toBe(true); expect(seen.calls.some(call => call.action === 'publish')).toBe(false);
});

test('requires explicit acknowledgement of pending lines and preserves manual changes before final publication', async ({ page }) => {
  const seen = await setup(page, { warning: true }); await openReferences(page); await prepare(page);
  await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true })).toBeDisabled(); await page.getByRole('checkbox').check();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('contatos-sinteticos.xlsx'); expect(dialog.message()).toContain('Alterações manuais serão preservadas'); return dialog.accept(); }); await page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); await expect(page.getByRole('status')).toContainText('1 alterações manuais preservadas'); expect(seen.calls.find(call => call.action === 'publish')?.body.confirm_quarantine).toBe(true);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});

test('pauses preparation at a confirmed chunk boundary and resumes the same original without another upload', async ({ page }) => {
  const seen = await setup(page, { holdFirstStage: true }); await openReferences(page); await prepare(page, 'contacts', 501);
  await expect.poll(() => seen.calls.filter(call => call.action === 'stage').length).toBe(1);
  await page.getByRole('button', { name: 'Interromper preparação', exact: true }).click(); await expect(page.getByRole('button', { name: 'Interrompendo após a etapa atual…', exact: true })).toBeDisabled(); seen.releaseStage();
  await expect(page.getByRole('status')).toContainText('Preparação interrompida'); expect(seen.calls.some(call => ['finish_prepare', 'publish'].includes(call.action))).toBe(false);
  await page.getByRole('button', { name: 'Preparar e conferir arquivo', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible(); expect(seen.uploads).toHaveLength(1); expect(seen.staged.size).toBe(2); expect(seen.job().staged_rows).toBe(501);
});

test('keeps a lost publication request frozen and repeats its exact protocol until the committed result is confirmed', async ({ page }) => {
  const seen = await setup(page, { lostPublishAck: true }); await openReferences(page); await prepare(page); await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Conferir confirmação pendente', exact: true })).toBeVisible(); await expect(page.locator('#collection-reference-file')).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('O resultado da conclusão ainda precisa ser confirmado'); await expect(page.getByRole('alert')).toContainText('CONCLUSÃO · HTTP503 · REF_SERVICE_UNAVAILABLE');
  await expect(page.getByText('private response lost', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Descrições dos títulos/ })).toBeDisabled(); await page.getByRole('button', { name: 'Conferir confirmação pendente', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); const requests = seen.calls.filter(call => call.action === 'publish'); expect(requests).toHaveLength(2); expect(requests[0].body).toEqual(requests[1].body); expect(seen.published.size).toBe(1);
});

test('recovers a lost confirmation from private history after changing the import tab without uploading or publishing twice', async ({ page }) => {
  const seen = await setup(page, { lostPublishAck: true }); await openReferences(page); await prepare(page); await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true }).click(); await expect(page.getByRole('button', { name: 'Conferir confirmação pendente', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Contas a Receber', exact: true }).click(); await openReferences(page); await page.getByRole('button', { name: 'Conferir arquivo contatos-sinteticos.xlsx', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Esta importação já foi concluída'); expect(seen.calls.filter(call => call.action === 'publish')).toHaveLength(1); expect(seen.uploads).toHaveLength(1);
});

test('reanalyses a prepared job after a financial revision conflict and uses a fresh confirmed request', async ({ page }) => {
  const seen = await setup(page, { stalePublish: true }); await openReferences(page); await prepare(page); await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
  page.on('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('A base foi atualizada');
  await page.getByRole('button', { name: 'Reanalisar arquivo preparado', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible(); await page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); const requests = seen.calls.filter(call => call.action === 'publish'); expect(requests[0].body.previous_financial_revision).not.toBe(requests[1].body.previous_financial_revision); expect(requests[0].body.request_id).not.toBe(requests[1].body.request_id); expect(seen.uploads).toHaveLength(1);
});

test('recognises an already published source and an already stored unverified original without uploading over them', async ({ page }) => {
  const seen = await setup(page, { existingPublished: true }); await openReferences(page); await prepare(page); await expect(page.getByRole('status')).toContainText('Este arquivo já foi concluído');
  expect(seen.uploads).toHaveLength(0); expect(seen.calls.some(call => ['stage', 'finish_prepare', 'publish'].includes(call.action))).toBe(false);
});

test('verifies a stored original before reusing its staged preparation', async ({ page }) => {
  const seen = await setup(page, { existingUnverified: true }); await openReferences(page); await prepare(page); await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
  expect(seen.uploads).toHaveLength(0); expect(seen.calls.findIndex(call => call.action === 'verify_original')).toBeLessThan(seen.calls.findIndex(call => call.action === 'stage'));
});

test('explains the open-titles-first order and preserves future descriptions exclusively for collection', async ({ page }) => {
  const seen = await setup(page); await openReferences(page); await prepare(page, 'descriptions');
  await expect(page.getByText('Primeiro: importe os abertos e vencidos de Contas a Receber.', { exact: true })).toBeVisible(); await expect(page.getByText('As descrições não são exibidas em Contas a Receber ou Comissões.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible(); expect(seen.calls.find(call => call.action === 'begin')?.body.mode).toBe('descriptions'); expect(seen.calls.some(call => call.url.includes('receivables-import'))).toBe(false);
});

for (const mode of ['contacts', 'descriptions'] as const) {
  for (const code of ['57014', '55P03'] as const) {
    test(mode + ' preserves a prepared job after ' + code + ' and rechecks it without reuploading or publishing', async ({ page }) => {
      const seen = await setup(page, { previewFailureOnce: code }); await openReferences(page); await prepare(page, mode);
      const alert = page.getByRole('alert'), http = code === '57014' ? 504 : 409;
      await expect(alert).toContainText(code === '57014' ? 'O banco interrompeu a conferência' : 'A preparação está ocupada por outra operação');
      await expect(alert).toContainText('não é necessário enviá-lo novamente');
      await expect(alert).toContainText('Código para suporte:');
      await expect(alert).toContainText('CONFERÊNCIA · HTTP' + http + ' · ' + code);
      await expect(alert).toContainText('collection-reference-import/2026-10-27.1 · ETAPA preview · ID ' + id(90));
      await expect(page.getByText('private SQL details must never reach the screen', { exact: false })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true })).toHaveCount(0);
      const sourceName = mode === 'contacts' ? 'contatos-sinteticos.xlsx' : 'descricoes-sinteticas.xlsx';
      await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Conferir arquivo ' + sourceName, exact: true }) })).toContainText('Pronto para conferência');
      expect(seen.job().status).toBe('PREPARED'); expect(seen.uploads).toHaveLength(1); expect(seen.staged.size).toBe(1); expect(seen.published.size).toBe(0);

      await page.getByRole('button', { name: 'Reanalisar arquivo preparado', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true })).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.locator('#collection-reference-file')).toHaveValue('');
      const previews = seen.calls.filter(call => call.action === 'preview');
      expect(previews).toHaveLength(2); expect(previews.map(call => call.body.job_id)).toEqual([id(10), id(10)]);
      for (const action of ['begin', 'stage', 'finish_prepare']) expect(seen.calls.filter(call => call.action === action)).toHaveLength(1);
      expect(seen.uploads).toHaveLength(1); expect(seen.calls.some(call => call.action === 'publish')).toBe(false); expect(seen.job().status).toBe('PREPARED');
    });
  }

  test(mode + ' retries a timed-out history preview after changing tabs with the original job intact', async ({ page }) => {
    const seen = await setup(page, { previewFailureOnce: '57014', previewFailureOnAttempt: 2 }); await openReferences(page); await prepare(page, mode);
    await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
    await page.getByRole('tab', { name: 'Contas a Receber', exact: true }).click(); await openReferences(page);
    const sourceName = mode === 'contacts' ? 'contatos-sinteticos.xlsx' : 'descricoes-sinteticas.xlsx';
    await page.getByRole('button', { name: 'Conferir arquivo ' + sourceName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('HTTP504 · 57014');
    await expect(page.getByRole('alert')).toContainText('As etapas já recebidas permanecem preservadas');
    await expect(page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true })).toHaveCount(0);
    expect(seen.job().status).toBe('PREPARED'); expect(seen.uploads).toHaveLength(1); expect(seen.calls.some(call => call.action === 'publish')).toBe(false);
    await page.getByRole('button', { name: 'Conferir arquivo ' + sourceName, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true })).toBeEnabled();
    await expect(page.locator('#collection-reference-file')).toHaveValue('');
    expect(seen.calls.filter(call => call.action === 'preview').map(call => call.body.job_id)).toEqual([id(10), id(10), id(10)]);
    expect(seen.calls.filter(call => call.action === 'status').map(call => call.body.job_id)).toEqual([id(10), id(10)]);
    expect(seen.calls.filter(call => call.action === 'begin')).toHaveLength(1); expect(seen.calls.filter(call => call.action === 'finish_prepare')).toHaveLength(1);
    expect(seen.job().mode).toBe(mode.toUpperCase()); expect(seen.job().status).toBe('PREPARED'); expect(seen.uploads).toHaveLength(1); expect(seen.staged.size).toBe(1); expect(seen.calls.some(call => call.action === 'publish')).toBe(false);
  });

  test(mode + ' blocks a malformed successful preview and allows rechecking the preserved preparation', async ({ page }) => {
    const seen = await setup(page, { malformedPreviewOnce: true }); await openReferences(page); await prepare(page, mode);
    await expect(page.getByRole('alert')).toContainText('conferência incompleta ou incompatível');
    await expect(page.getByRole('alert')).toContainText('HTTP200 · REF_INVALID_PREVIEW');
    await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true })).toHaveCount(0);
    expect(seen.job().status).toBe('PREPARED'); expect(seen.calls.some(call => call.action === 'publish')).toBe(false);
    await page.getByRole('button', { name: 'Reanalisar arquivo preparado', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Conferência antes de concluir' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Concluir importação deste arquivo', exact: true })).toBeEnabled();
    expect(seen.calls.filter(call => call.action === 'preview').map(call => call.body.job_id)).toEqual([id(10), id(10)]);
    expect(seen.uploads).toHaveLength(1); expect(seen.staged.size).toBe(1); expect(seen.calls.some(call => call.action === 'publish')).toBe(false);
  });
}

for (const role of ['diretor', 'contas_pagar', 'rh_dp', 'cobradora_1']) {
  test('reference import is hidden from role ' + role + ' even when financial permissions are present', async ({ page }) => {
    const seen = await setup(page, { role });
    if (role === 'diretor') await expect(page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Contatos e descrições', exact: true })).toHaveCount(0); expect(seen.calls).toHaveLength(0); expect(seen.uploads).toHaveLength(0);
  });
}
test('CR needs all official import permissions and does not gain the area from a read-only grant', async ({ page }) => {
  const seen = await setup(page, { missingWrite: true }); await expect(page.getByRole('tab', { name: 'Contatos e descrições', exact: true })).toHaveCount(0); expect(seen.calls).toHaveLength(0);
});
test('Manager can access the reference importer with the same official permissions', async ({ page }) => {
  await setup(page, { role: 'gerente_geral' }); await openReferences(page); await expect(page.getByRole('heading', { name: 'Contatos e descrições da Cobrança' })).toBeVisible();
});
test('missing activation is reported without leaking database details or sending source bytes', async ({ page }) => {
  const seen = await setup(page, { activationMissing: true }); await openReferences(page); await expect(page.getByRole('alert')).toContainText('precisa ser ativada'); await expect(page.getByText('private SQL relation details')).toHaveCount(0); expect(seen.uploads).toHaveLength(0);
});
