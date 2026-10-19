import { MAX_ROWS, parseCivilDate, parseMoneyCents } from './payables-parser.mjs';

const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const LABELS = { branch:'Filial', employee:'Funcionário', sector:'Setor', admitted_on:'Admissão', birthday_on:'Aniversário', salary_base_cents:'Salário Base', payroll_salary_cents:'Salário da folha', transport_cents:'VT TOTAL', advance_cents:'Adiantamento', cost_allowance_cents:'Ajuda de Custo', total_cents:'Total', count_label:'Contagem' };
const HEADERS = { FILIAL:'branch', FUNCIONARIO:'employee', SETOR:'sector', ADMISSAO:'admitted_on', ANIVERSARIO:'birthday_on', VTTOTAL:'transport_cents', VT:'transport_cents', ADIANTAMENTO:'advance_cents', AJUDADECUSTO:'cost_allowance_cents', AJUDACUSTO:'cost_allowance_cents', TOTAL:'total_cents', CONTAGEM:'count_label', SALARIOBASE:'salary_base_cents', SALARIODAFOLHA:'payroll_salary_cents', SALARIOFOLHA:'payroll_salary_cents' };
const MONEY = ['salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','cost_allowance_cents','total_cents'];
// Confirmado pela operação: vazio é zero nestas colunas quando presentes no arquivo.
// A ausência da coluna, dos salários ou do TOTAL permanece desconhecida.
const BLANK_IS_ZERO = new Set(['transport_cents','advance_cents','cost_allowance_cents']);
const blank = value => value === null || value === undefined || typeof value === 'string' && !value.trim();
function scalar(value) {
  if (blank(value)) return '';
  if (typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Fórmula não permitida. Salve uma cópia somente com valores.');
    if (Array.isArray(value.richText)) return scalar(value.richText.map(part => part.text).join(''));
    if ('text' in value && 'hyperlink' in value) return scalar(value.text);
    throw new Error('Célula não suportada. Use texto, data ou número.');
  }
  if (!['string','number'].includes(typeof value) && !(value instanceof Date)) throw new Error('Tipo de célula inválido.');
  if (typeof value === 'string' && (/^\s*[=+@]/.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new Error('Conteúdo inválido ou interpretável como fórmula. Salve somente valores.');
  return value;
}
function date(value, excel1904) {
  if (blank(value)) return null;
  // Excel dates preserve their civil UTC components. Clock portions from an ERP
  // are accepted only when they are midnight; abbreviated years stay ambiguous.
  return parseCivilDate(value, excel1904);
}
function money(value, key) {
  if (blank(value)) return BLANK_IS_ZERO.has(key) ? 0 : null;
  if (typeof value === 'string' && /^(?:R\$\s*)?[-–—]$/.test(value.trim())) return 0;
  let sign = 1, source = value;
  if (typeof value === 'number' && value < 0) { sign = -1; source = -value; }
  else if (typeof value === 'string' && /^\s*(?:-\s*R\$|R\$\s*-|-)/.test(value)) {
    sign = -1; source = value.trim().replace(/^(?:-\s*R\$\s*|R\$\s*-\s*|-\s*)/, '');
  }
  if (key === 'salary_base_cents' && sign < 0) throw new Error('Salário base não pode ser negativo.');
  return sign * parseMoneyCents(source);
}

// Named salary fields take priority; remaining SALÁRIO columns fill base then
// payroll. This supports SALÁRIO BASE + SALÁRIO and the legacy repeated SALÁRIO
// layout without overwriting either value when converting the sheet to rows.
export function validateHrRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  const problem = (line,column,message) => errors.push({line,column,problem:message,correction:'Corrija a célula no arquivo original e selecione uma nova cópia.'});
  if (!Array.isArray(matrix) || !matrix.length) return {rows,errors:[{line:1,column:'Arquivo',problem:'Arquivo vazio.',correction:'Exporte a base de RH/DP com seus cabeçalhos.'}]};
  const candidates = [];
  for (let line=0;line<Math.min(matrix.length,20);line++) {
    if (!Array.isArray(matrix[line])) continue;
    let head;
    try { head=matrix[line].map(value=>normalize(scalar(value))); } catch { continue; }
    if (head.includes('FILIAL') && head.includes('FUNCIONARIO') && head.includes('SETOR')) candidates.push({line,head});
  }
  if (!candidates.length) return {rows,errors:[{line:1,column:'Cabeçalho',problem:'Não encontrei FILIAL, SETOR e FUNCIONÁRIO na mesma linha.',correction:'Inclua os três cabeçalhos. Use Salário Base e Salário, ou dois SALÁRIO na ordem base e folha.'}]};
  const {line:headerLine,head}=candidates[0];
  if (head.length>100) problem(headerLine+1,'Cabeçalho','A base excede 100 colunas.');
  const columns=new Map(), unnamedSalaries=[];
  head.forEach((header,index)=>{
    if(header==='SALARIO') { unnamedSalaries.push(index);return; }
    const key=HEADERS[header];
    if(key&&columns.has(key))problem(headerLine+1,LABELS[key],'Coluna duplicada ou ambígua.');else if(key)columns.set(key,index);
  });
  const remainingSalaries=['salary_base_cents','payroll_salary_cents'].filter(key=>!columns.has(key));
  if(unnamedSalaries.length>remainingSalaries.length)problem(headerLine+1,'Salário','Há mais de duas colunas de salário ou a identificação está ambígua.');
  else unnamedSalaries.forEach((column,index)=>columns.set(remainingSalaries[index],column));
  if(errors.length)return{rows,errors};
  let count=0;const total=Object.fromEntries(MONEY.map(key=>[key,0n]));
  for(let index=headerLine+1;index<matrix.length;index++){
    const source=matrix[index];
    if(!Array.isArray(source)){problem(index+1,'Arquivo','Linha inválida.');continue;}
    if(source.every(blank))continue;
    if(++count>MAX_ROWS){problem(index+1,'Arquivo','A base excede 5.000 registros.');break;}
    const before=errors.length;
    if(source.length>100||source.slice(head.length).some(value=>!blank(value)))problem(index+1,'Arquivo','Há valores fora das colunas do cabeçalho.');
    for(let column=0;column<source.length;column++)try{scalar(source[column]);}catch(error){problem(index+1,`Coluna ${column+1}`,error.message);}
    const row={source_row:index+1,branch:'',employee:'',sector:'',admitted_on:null,birthday_on:null,salary_base_cents:null,payroll_salary_cents:null,transport_cents:null,advance_cents:null,cost_allowance_cents:null,total_cents:null,count_label:null};
    for(const[key,column]of columns){try{
      const value=scalar(source[column]);
      if(MONEY.includes(key))row[key]=money(value,key);
      else if(key==='admitted_on'||key==='birthday_on')row[key]=date(value,excel1904);
      else {row[key]=String(value).trim().replace(/\s+/g,' ');if(row[key].length>(key==='employee'?300:150))throw new Error('Texto excede o limite de caracteres.');if(key==='employee'&&!row[key])throw new Error('Nome do funcionário obrigatório.');if(key==='count_label'&&!row[key])row[key]=null;}
    }catch(error){problem(index+1,LABELS[key],error.message);}}
    if(!row.employee&&!errors.slice(before).some(error=>error.column==='Funcionário'))problem(index+1,'Funcionário','Nome do funcionário obrigatório; linhas de totais não pertencem à base.');
    if(errors.length===before){
      for(const key of MONEY){if(row[key]!==null){total[key]+=BigInt(Math.abs(row[key]));if(total[key]>BigInt(Number.MAX_SAFE_INTEGER))problem(index+1,LABELS[key],'O total da coluna excede o limite de precisão.');}}
      if(errors.length===before)rows.push(row);
    }
    if(errors.length>=100)break;
  }
  if(!rows.length&&!errors.length)problem(headerLine+2,'Arquivo','A base não contém funcionários. Uma base vazia não substitui a posição atual.');
  return {rows:errors.length?[]:rows,errors:errors.slice(0,100)};
}
export const parseHrRows = validateHrRows;
