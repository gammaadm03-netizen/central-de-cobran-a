import { normalizeReceivableCollectorName } from './receivables-parser.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const validKey = value => typeof value === 'string' && /^(name:.+|cnpj:\d{14})$/.test(value) && value.length <= 1505 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
/** File names only propose a responsible for an official, unassigned customer group. */
export function resolveReceivableCollectorHints({ hints, assignments, collectors, mappings = {} }) {
  if (!Array.isArray(hints) || hints.length > 5000 || !Array.isArray(assignments) || assignments.length > 5000 || !Array.isArray(collectors)
    || !mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error('Conferência de cobradoras inválida. Analise o arquivo novamente.');
  const groups = new Map(), activeById = new Map(), activeByName = new Map(), hinted = new Map(), lines = new Set();
  for (const assignment of assignments) {
    if (!assignment || !validKey(assignment.customer_key) || groups.has(assignment.customer_key) || typeof assignment.requires_selection !== 'boolean' || typeof assignment.locked !== 'boolean') throw new Error('Carteiras oficiais inválidas. Analise novamente.');
    groups.set(assignment.customer_key, assignment);
  }
  for (const collector of collectors) {
    if (!collector || !uuid.test(collector.id) || typeof collector.display_name !== 'string' || collector.enabled !== true || activeById.has(collector.id)) throw new Error('Cadastro de cobradoras inválido. Atualize o histórico e tente novamente.');
    activeById.set(collector.id, collector);
    const name = normalizeReceivableCollectorName(collector.display_name), matches = activeByName.get(name) ?? [];
    matches.push(collector); activeByName.set(name, matches);
  }
  for (const hint of hints) {
    if (!hint || !Number.isSafeInteger(hint.line) || hint.line < 2 || hint.line > 5001 || lines.has(hint.line) || !validKey(hint.customer_key)
      || typeof hint.collector_name !== 'string' || !hint.collector_name.trim() || hint.collector_name.length > 150 || /[\u0000-\u001f\u007f-\u009f]/.test(hint.collector_name)
      || !groups.has(hint.customer_key)) throw new Error('A coluna COBRADORA não corresponde à conferência do arquivo. Analise novamente.');
    lines.add(hint.line);
    const customerHints = hinted.get(hint.customer_key) ?? [];
    customerHints.push(hint); hinted.set(hint.customer_key, customerHints);
  }
  const effective = {}, problems = [], summary = {
    file_title_count: hints.length, file_customer_count: hinted.size,
    assigned_customer_count: 0, preserved_customer_count: 0, manual_customer_count: 0,
  };
  for (const [key, group] of groups) {
    const customerHints = hinted.get(key) ?? [], first = customerHints[0];
    if (!group.requires_selection || group.locked) {
      if (first && group.collector_id) summary.preserved_customer_count++;
      continue;
    }
    if (customerHints.length && new Set(customerHints.map(item => normalizeReceivableCollectorName(item.collector_name))).size > 1) {
      problems.push({ line: first.line, column: 'COBRADORA', problem: 'O mesmo cliente possui cobradoras diferentes no arquivo.', correction: 'Mantenha a mesma cobradora para todos os títulos desse cliente e analise novamente.' });
      continue;
    }
    if (Object.hasOwn(mappings, key)) {
      const selected = mappings[key];
      if (selected === '') continue; // Explicitly cleared by the operator; the official preview requires a new choice.
      if (typeof selected !== 'string' || !activeById.has(selected)) throw new Error('A cobradora selecionada não está ativa. Atualize o histórico e escolha novamente.');
      effective[key] = selected; summary.manual_customer_count++;
      continue;
    }
    if (!first) continue;
    const matches = activeByName.get(normalizeReceivableCollectorName(first.collector_name)) ?? [];
    if (matches.length !== 1) {
      problems.push({ line: first.line, column: 'COBRADORA',
        problem: matches.length ? `O nome “${first.collector_name}” corresponde a mais de uma cobradora ativa.` : `A cobradora “${first.collector_name}” não foi encontrada entre as cobradoras ativas.`,
        correction: 'Escolha a cobradora correta na conferência de carteiras da Central e analise novamente.' });
      continue;
    }
    effective[key] = matches[0].id; summary.assigned_customer_count++;
  }
  return { mappings: effective, problems, summary };
}
