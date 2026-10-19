import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionEmailLinks, collectionEmailMessage, collectionEmailSource, validCollectionEmailDraft } from './collection-email-message.mjs';

const requestId = '11111111-1111-4111-8111-111111111111';
const titleId = '22222222-2222-4222-8222-222222222222';
const anotherId = '33333333-3333-4333-8333-333333333333';
function draft() {
  return { request_id: requestId, title_id: titleId, customer_key: 'orgao-modelo', client_name: 'Órgão Modelo', as_of_date: '2026-10-19',
    emails: ['financeiro@example.org', 'contratos@example.org'], revision: 'snapshot-modelo',
    rows: [{ title_id: titleId, document: 'NF 101/1', branch: '01', due_date: '2026-10-18', amount_cents: 123456, category: 'OVERDUE' },
      { title_id: anotherId, document: 'NF 102/1', branch: '02', due_date: '2026-10-19', amount_cents: 5001, category: 'UPCOMING' }],
    overdue_count: 1, upcoming_count: 1, total_count: 2, overdue_cents: 123456, upcoming_cents: 5001, total_cents: 128457 };
}
const completion = { requestId, titleId };

test('email draft agrees with completion, all unique rows and exact safe integer totals', () => {
  assert.equal(validCollectionEmailDraft(draft(), completion), true);
  const invalids = [
    value => { value.total_cents++; }, value => { value.overdue_cents++; }, value => { value.upcoming_count++; }, value => { value.rows.pop(); },
    value => { value.rows[1].title_id = titleId; }, value => { value.rows[0].amount_cents = 1.5; }, value => { value.rows[0].amount_cents = -1; },
    value => { value.rows[0].amount_cents = Number.MAX_SAFE_INTEGER + 1; }, value => { value.title_id = anotherId; },
    value => { value.request_id = anotherId; }, value => { value.rows[0].category = 'UPCOMING'; }, value => { value.rows[1].category = 'OVERDUE'; },
    value => { value.rows[0].due_date = '2026-02-30'; }, value => { value.as_of_date = '2026-13-01'; },
    value => { value.rows[0].observation = 'INTERNAL ONLY'; }, value => { value.note = 'INTERNAL ONLY'; },
  ];
  for (const mutate of invalids) { const value = draft(); mutate(value); assert.equal(validCollectionEmailDraft(value, completion), false, mutate.toString()); }
  const overflow = draft();
  overflow.rows[0].amount_cents = Number.MAX_SAFE_INTEGER; overflow.overdue_cents = Number.MAX_SAFE_INTEGER;
  assert.equal(validCollectionEmailDraft(overflow, completion), false);
});

test('a paid anchor may be absent and a cleared customer has a valid empty zero summary', () => {
  const value = draft(); value.title_id = '44444444-4444-4444-8444-444444444444';
  assert.equal(validCollectionEmailDraft(value, { ...completion, titleId: value.title_id }), true);
  value.rows = []; value.overdue_count = value.upcoming_count = value.total_count = value.overdue_cents = value.upcoming_cents = value.total_cents = 0;
  value.emails = [];
  assert.equal(validCollectionEmailDraft(value, { ...completion, titleId: value.title_id }), true);
  const message = collectionEmailMessage(value);
  assert.match(message.body, /TOTAL: 0 título\(s\) — R\$ 0,00/);
  value.total_cents = 1; assert.equal(validCollectionEmailDraft(value, { ...completion, titleId: value.title_id }), false);
});

test('email draft rejects header/control injection and bounds official contacts and row counts', () => {
  const invalids = [
    value => { value.client_name += '\r\nBcc: outsider@example.org'; }, value => { value.customer_key += '\u0000'; },
    value => { value.rows[0].document += '\nFake title'; }, value => { value.rows[0].branch += '\t'; },
    value => { value.emails = ['financeiro@example.org\r\nBcc: outsider@example.org']; },
    value => { value.emails = ['Name <financeiro@example.org>']; }, value => { value.emails = ['financeiro@example.org,outsider@example.org']; },
    value => { value.emails = ['financeiro@example.org', 'FINANCEIRO@example.org']; }, value => { value.emails = Array.from({ length: 51 }, (_, i) => `contact${i}@example.org`); },
    value => { value.rows = Array.from({ length: 5001 }, () => value.rows[0]); }, value => { value.revision = 'a'.repeat(257); },
  ];
  for (const mutate of invalids) { const value = draft(); mutate(value); assert.equal(validCollectionEmailDraft(value, completion), false, mutate.toString()); }
});

test('draft email groups overdue and upcoming rows with their full document, branch, due date and exact amounts', () => {
  const value = draft(), before = JSON.stringify(value), message = collectionEmailMessage(value);
  assert.equal(message.subject, 'Pendências financeiras — Órgão Modelo');
  assert.match(message.body, /Posição em 19\/10\/2026/);
  assert.match(message.body, /TÍTULOS VENCIDOS\nDocumento: NF 101\/1 \| Filial: 01 \| Vencimento: 18\/10\/2026 \| Valor: R\$ 1\.234,56/);
  assert.match(message.body, /TÍTULOS A VENCER\nDocumento: NF 102\/1 \| Filial: 02 \| Vencimento: 19\/10\/2026 \| Valor: R\$ 50,01/);
  assert.match(message.body, /TOTAL: 2 título\(s\) — R\$ 1\.284,57/);
  assert.match(message.body, /previsão de pagamento/); assert.match(message.body, /envie o comprovante/);
  assert.match(message.body, /Central Financeira — Grupo Ecoplast$/);
  assert.equal(JSON.stringify(value), before);
});

test('message money formatting remains exact through the largest safe integer cent amount', () => {
  const value = draft(); value.rows = [value.rows[0]];
  value.rows[0].amount_cents = value.overdue_cents = value.total_cents = Number.MAX_SAFE_INTEGER;
  value.upcoming_count = value.upcoming_cents = 0; value.total_count = 1;
  assert.match(collectionEmailMessage(value).body, /R\$ 90\.071\.992\.547\.409,91/);
});

test('canonical maximum customer names and document/branch limits remain readable and exportable', () => {
  const value = draft(); value.client_name = 'Á'.repeat(1500); value.customer_key = 'k'.repeat(1505);
  value.rows[0].document = 'D'.repeat(150); value.rows[0].branch = 'F'.repeat(150);
  assert.equal(validCollectionEmailDraft(value, completion), true);
  const { subject, body } = collectionEmailMessage(value);
  assert.ok(subject.includes(value.client_name));
  assert.doesNotThrow(() => collectionEmailSource(value.emails, subject, body));
  assert.deepEqual(collectionEmailLinks(value.emails, subject, body), { gmail: null, outlook: null, mailto: null });
  value.rows[0].branch += 'F'; assert.equal(validCollectionEmailDraft(value, completion), false);
});

test('email clients receive encoded complete content and only explicitly selected recipients', () => {
  const subject = 'Posição & previsão?', body = 'Prezados,\nDocumento #123 & total R$ 10,00\nAção e revisão.';
  const links = collectionEmailLinks(['financeiro+unidade@example.org'], subject, body);
  for (const key of ['gmail', 'outlook']) {
    const url = new URL(links[key]);
    assert.equal(url.searchParams.get('to'), 'financeiro+unidade@example.org');
    assert.equal(url.searchParams.get(key === 'gmail' ? 'su' : 'subject'), subject);
    assert.equal(url.searchParams.get('body'), key === 'outlook' ? body.replaceAll('&', '&amp;').replaceAll('\n', '<br>') : body);
  }
  const mailto = new URL(links.mailto);
  assert.equal(decodeURIComponent(mailto.pathname), 'financeiro+unidade@example.org');
  assert.equal(mailto.searchParams.get('subject'), subject); assert.equal(mailto.searchParams.get('body'), body);
  assert.equal(new URL(links.gmail).hostname, 'mail.google.com');
  assert.equal(new URL(links.outlook).hostname, 'outlook.office.com');
});

test('long drafts disable oversized links without truncating the message or eml', () => {
  const subject = 'Pendências', body = 'Documento e valor integral.\n'.repeat(500);
  const links = collectionEmailLinks(['financeiro@example.org'], subject, body);
  assert.deepEqual(links, { gmail: null, outlook: null, mailto: null });
  const eml = collectionEmailSource(['financeiro@example.org'], subject, body);
  const payload = eml.slice(eml.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '');
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), body.replace(/\n/g, '\r\n'));
});

test('eml preserves UTF-8 subject and full body with CRLF and folded headers/base64, without inventing a sender', () => {
  const subject = `Cobrança — ${'Órgão público '.repeat(12).trim()}`, body = 'Prezados,\nAção: informar previsão.\r\nDocumento: 10\rTotal: R$ 123,45\n';
  const eml = collectionEmailSource(['financeiro@example.org', 'contato@example.org'], subject, body);
  assert.match(eml, /^To: financeiro@example\.org,\r\n contato@example\.org\r\nSubject:/);
  assert.match(eml, /\r\nX-Unsent: 1\r\n/); assert.doesNotMatch(eml, /(?:^|\r\n)From:/);
  assert.equal(eml.replace(/\r\n/g, '').includes('\n'), false);
  const headers = eml.slice(0, eml.indexOf('\r\n\r\n'));
  const encoded = headers.match(/Subject: ([\s\S]*?)\r\nMIME-Version/)[1];
  const decoded = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(match => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(match[1], 'base64'))).join('');
  assert.equal(decoded, subject);
  for (const word of encoded.match(/=\?UTF-8\?B\?[^?]+\?=/g)) assert.ok(word.length <= 75);
  const payload = eml.slice(eml.indexOf('\r\n\r\n') + 4);
  for (const line of payload.split('\r\n')) assert.ok(line.length <= 76);
  assert.equal(Buffer.from(payload.replace(/\r\n/g, ''), 'base64').toString('utf8'), body.replace(/\r\n?|\n/g, '\r\n'));
});

test('all compose/export entrypoints reject recipient and subject injection', () => {
  for (const emails of [[], [''], ['wrong address'], ['a@example.org\r\nBcc:x@example.org'], ['a@example.org', 'A@example.org'], Array.from({ length: 51 }, (_, i) => `a${i}@example.org`)]) {
    assert.throws(() => collectionEmailLinks(emails, 'Cobrança', 'Mensagem'), /invalid_email_recipients/);
    assert.throws(() => collectionEmailSource(emails, 'Cobrança', 'Mensagem'), /invalid_email_recipients/);
  }
  for (const subject of ['Cobrança\r\nBcc: x@example.org', 'Cobrança\u0000', '\ud800']) {
    assert.throws(() => collectionEmailLinks(['a@example.org'], subject, 'Mensagem'), /invalid_email_content/);
    assert.throws(() => collectionEmailSource(['a@example.org'], subject, 'Mensagem'), /invalid_email_content/);
  }
});


test('Outlook HTML body treats imported markup as literal text and keeps Gmail plain', () => {
  const body = 'Cliente: <img src="https://invalid.example/pixel"> & aviso\nDocumento <script>teste</script>';
  const links = collectionEmailLinks(['financeiro@example.org'], 'Conferência', body);
  const outlook = new URL(links.outlook).searchParams.get('body');
  assert.equal(outlook, 'Cliente: &lt;img src=&quot;https://invalid.example/pixel&quot;&gt; &amp; aviso<br>Documento &lt;script&gt;teste&lt;/script&gt;');
  assert.equal(new URL(links.gmail).searchParams.get('body'), body);
});

test('upcoming-only message does not request payment for nonexistent overdue titles', () => {
  const value = draft(); value.rows = [value.rows[1]];
  value.overdue_count = value.overdue_cents = 0; value.total_count = 1; value.total_cents = value.upcoming_cents;
  const message = collectionEmailMessage(value);
  assert.match(message.body, /títulos a vencer para acompanhamento/);
  assert.doesNotMatch(message.body, /previsão de pagamento para os títulos vencidos/);
});
