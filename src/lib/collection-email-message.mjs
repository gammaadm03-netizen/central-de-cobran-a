const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_URL_LENGTH = 1800;
const draftKeys = ['request_id', 'title_id', 'customer_key', 'client_name', 'as_of_date', 'emails', 'rows', 'overdue_count', 'upcoming_count', 'total_count', 'overdue_cents', 'upcoming_cents', 'total_cents', 'revision'];
const rowKeys = ['title_id', 'document', 'branch', 'due_date', 'amount_cents', 'category'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !CONTROL.test(value) && value.isWellFormed();
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function civilDate(value) {
  if (typeof value !== 'string' || !/^(?:19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function emailAddress(value) {
  if (!text(value, 254) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(value)) return false;
  const local = value.slice(0, value.indexOf('@'));
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}
function recipients(emails) {
  if (!Array.isArray(emails) || !emails.length || emails.length > 50 || emails.some(email => !emailAddress(email)) || new Set(emails.map(email => email.toLowerCase())).size !== emails.length) throw new Error('invalid_email_recipients');
  return emails;
}
function content(subject, body) {
  if (!text(subject, 4096) || typeof body !== 'string' || !body.length || body.length > 10000000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(body) || !body.isWellFormed()) throw new Error('invalid_email_content');
}

/** The financial summary must agree with every complete, uniquely identified row. */
export function validCollectionEmailDraft(value, completion) {
  if (!exactKeys(value, draftKeys) || !completion || !UUID.test(completion.requestId ?? '') || !UUID.test(completion.titleId ?? '')
    || value.request_id !== completion.requestId || value.title_id !== completion.titleId
    || !text(value.customer_key, 1505) || !text(value.client_name, 1500) || !text(value.revision, 256) || !civilDate(value.as_of_date)
    || !Array.isArray(value.emails) || value.emails.length > 50 || value.emails.some(email => !emailAddress(email)) || new Set(value.emails.map(email => email.toLowerCase())).size !== value.emails.length
    || !Array.isArray(value.rows) || value.rows.length > 5000
    || !['overdue_count', 'upcoming_count', 'total_count', 'overdue_cents', 'upcoming_cents', 'total_cents'].every(key => integer(value[key]))) return false;
  const ids = new Set();
  let overdueCount = 0, upcomingCount = 0, overdue = 0n, upcoming = 0n;
  for (const row of value.rows) {
    if (!exactKeys(row, rowKeys) || typeof row.title_id !== 'string' || !UUID.test(row.title_id) || ids.has(row.title_id.toLowerCase())
      || !text(row.document, 150) || !text(row.branch, 150) || !civilDate(row.due_date) || !integer(row.amount_cents)
      || !['OVERDUE', 'UPCOMING'].includes(row.category) || (row.due_date < value.as_of_date) !== (row.category === 'OVERDUE')) return false;
    ids.add(row.title_id.toLowerCase());
    if (row.category === 'OVERDUE') { overdueCount++; overdue += BigInt(row.amount_cents); }
    else { upcomingCount++; upcoming += BigInt(row.amount_cents); }
  }
  return overdueCount === value.overdue_count && upcomingCount === value.upcoming_count
    && value.rows.length === value.total_count && overdue + upcoming <= BigInt(Number.MAX_SAFE_INTEGER)
    && overdue === BigInt(value.overdue_cents) && upcoming === BigInt(value.upcoming_cents) && overdue + upcoming === BigInt(value.total_cents);
}

function money(cents) {
  const value = BigInt(cents);
  return `R$ ${new Intl.NumberFormat('pt-BR').format(value / 100n)},${String(value % 100n).padStart(2, '0')}`;
}
const dateLabel = date => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
export function collectionEmailMessage(draft) {
  if (!validCollectionEmailDraft(draft, { requestId: draft?.request_id, titleId: draft?.title_id })) throw new Error('invalid_collection_email_draft');
  const lines = ['Prezados,', '', `Cliente: ${draft.client_name}`, `Posição em ${dateLabel(draft.as_of_date)}.`, '',
    draft.overdue_count > 0 ? 'Solicitamos, por gentileza, uma previsão de pagamento para os títulos vencidos relacionados abaixo. Também apresentamos os títulos a vencer para acompanhamento.' : 'Apresentamos abaixo os títulos a vencer para acompanhamento.', ''];
  for (const [category, heading, count, total] of [['OVERDUE', 'TÍTULOS VENCIDOS', draft.overdue_count, draft.overdue_cents], ['UPCOMING', 'TÍTULOS A VENCER', draft.upcoming_count, draft.upcoming_cents]]) {
    lines.push(heading);
    const rows = draft.rows.filter(row => row.category === category).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.document.localeCompare(b.document) || a.branch.localeCompare(b.branch) || a.title_id.localeCompare(b.title_id));
    if (!rows.length) lines.push('Nenhum título nesta situação.');
    for (const row of rows) lines.push(`Documento: ${row.document} | Filial: ${row.branch} | Vencimento: ${dateLabel(row.due_date)} | Valor: ${money(row.amount_cents)}`);
    lines.push(`Subtotal: ${count} título(s) — ${money(total)}`, '');
  }
  lines.push(`TOTAL: ${draft.total_count} título(s) — ${money(draft.total_cents)}`, '',
    'Caso o pagamento já tenha sido efetuado, pedimos que nos envie o comprovante para conferência.', '',
    'Agradecemos a atenção e ficamos à disposição.', '', 'Atenciosamente,', 'Central Financeira — Grupo Ecoplast');
  return { subject: `Pendências financeiras — ${draft.client_name}`, body: lines.join('\n') };
}

/** Long drafts remain complete in the preview and .eml; links are never truncated. */
export function collectionEmailLinks(emails, subject, body) {
  recipients(emails); content(subject, body);
  const to = encodeURIComponent(emails.join(',')), su = encodeURIComponent(subject), message = encodeURIComponent(body);
  // Outlook's web composer accepts HTML. Only our line breaks are markup;
  // imported customer/document text must remain literal content.
  const outlookBody = body.replace(/\r\n?|\n/g, '\n').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])).replaceAll('\n', '<br>');
  const links = {
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${message}`,
    outlook: `https://outlook.office.com/mail/deeplink/compose?to=${to}&subject=${su}&body=${encodeURIComponent(outlookBody)}`,
    mailto: `mailto:${emails.map(email => encodeURIComponent(email)).join(',')}?subject=${su}&body=${message}`,
  };
  return Object.fromEntries(Object.entries(links).map(([key, link]) => [key, link.length <= MAX_URL_LENGTH ? link : null]));
}

function base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary);
}
function encodedSubject(subject) {
  const parts = [];
  let part = '', length = 0;
  for (const char of subject) {
    const bytes = new TextEncoder().encode(char).length;
    if (length + bytes > 39) { parts.push(`=?UTF-8?B?${base64(part)}?=`); part = ''; length = 0; }
    part += char; length += bytes;
  }
  if (part) parts.push(`=?UTF-8?B?${base64(part)}?=`);
  return parts.join('\r\n ');
}
export function collectionEmailSource(emails, subject, body) {
  recipients(emails); content(subject, body);
  const payload = base64(body.replace(/\r\n?|\n/g, '\r\n')).match(/.{1,76}/g)?.join('\r\n') ?? '';
  return [`To: ${emails.join(',\r\n ')}`, `Subject: ${encodedSubject(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'X-Unsent: 1', '', payload, ''].join('\r\n');
}
