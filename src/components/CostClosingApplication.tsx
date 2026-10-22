import { useEffect, useRef, useState, type FormEvent } from 'react';
import { officialToday } from './Treasury';
import { dateLabel, formatCents } from '../lib/payables';
import { costDecimal, costQuantity, costUuid, displayUnitCost, productCostError, productCostRequest, type CostRecalculation, type CostRecalculationBody, type CostSource } from '../lib/product-costs';

const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const money = (value: unknown) => value === null || Number.isSafeInteger(value);
const cash = (value: number | null) => value === null ? 'Não informado' : formatCents(value);
function validPreview(data: CostRecalculation, source: CostSource, month: string) {
  return data?.format_version === 'costs-recalculation-v1' && data.month === month && data.cost_import_id === source.import_id
    && (data.previous_import_id === null || costUuid(data.previous_import_id)) && typeof data.can_apply === 'boolean' && (data.already_applied === undefined || typeof data.already_applied === 'boolean')
    && [data.row_count,data.matched_count,data.missing_code_count,data.missing_quantity_count,data.invalid_quantity_count,data.missing_cost_count,data.zero_cost_count,data.missing_components_count].every(integer)
    && !!data.totals && Object.values(data.totals).length === 4 && Object.values(data.totals).every(money)
    && data.cost_source?.import_id === source.import_id && Array.isArray(data.rows) && data.rows.length === data.row_count && data.rows.length <= 5000
    && data.rows.every(row => costUuid(row.id) && integer(row.line_number) && typeof row.code === 'string' && typeof row.product === 'string' && typeof row.invoice === 'string' && typeof row.branch === 'string'
      && (row.quantity === null || costQuantity(row.quantity)) && (row.unit_cost === null || costDecimal(row.unit_cost))
      && [row.previous_cost_cents,row.new_cost_cents,row.previous_margin_cents,row.new_margin_cents].every(money) && Array.isArray(row.error_codes) && row.error_codes.every(code => typeof code === 'string'))
    && (!data.can_apply || data.row_count > 0 && costUuid(data.previous_import_id) && data.source?.import_id === data.previous_import_id && Object.values(data.totals).every(Number.isSafeInteger) && data.rows.every(row => !row.error_codes.length));
}
function problemLabel(code: string) {
  const key = code.toUpperCase();
  if (key.includes('CODE') || key.includes('PRODUCT')) return 'Código sem correspondência na base de custos';
  if (key.includes('QUANTITY')) return key.includes('MISSING') ? 'Quantidade não informada no fechamento' : 'Quantidade inválida para o cálculo';
  if (key.includes('ZERO')) return 'Custo unitário zerado: confira o custo correto';
  if (key.includes('COMPONENT') || key.includes('FREIGHT') || key.includes('TAX') || key.includes('COMMISSION')) return 'Frete, imposto ou comissão não informados';
  if (key.includes('COST')) return 'Custo unitário não informado ou inválido';
  if (key.includes('OVERFLOW') || key.includes('PRECISION')) return 'Valor acima do limite de precisão';
  return 'Confira os dados desta linha antes de aplicar';
}
export default function CostClosingApplication({ costSource, disabled, onBusyChange, onApplied }: { costSource: CostSource; disabled: boolean; onBusyChange: (busy: boolean) => void; onApplied?: () => void }) {
  const [month,setMonth] = useState(() => officialToday().slice(0,7)), [analysis,setAnalysis] = useState<CostRecalculation | null>(null);
  const [reviewed,setReviewed] = useState(false), [busy,setBusy] = useState<'preview'|'commit'|null>(null), [pending,setPending] = useState<CostRecalculationBody|null>(null);
  const [error,setError] = useState(''), [success,setSuccess] = useState(''), [page,setPage] = useState(0);
  const generation=useRef(0), controller=useRef<AbortController|null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { onBusyChange(!!busy || !!pending); return () => onBusyChange(false); }, [busy,pending,onBusyChange]);
  useEffect(() => { generation.current++; controller.current?.abort(); setAnalysis(null); setReviewed(false); setError(''); setSuccess(''); setPage(0); }, [costSource.import_id]);
  useEffect(() => { if (!pending && busy!=='commit') return; const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn); },[pending,busy]);
  async function analyze(event?:FormEvent) {
    event?.preventDefault();if(disabled||busy||pending||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return;
    const current=++generation.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;setBusy('preview');setError('');setSuccess('');setAnalysis(null);setReviewed(false);setPage(0);
    try { const data=await productCostRequest<CostRecalculation>({action:'preview',mode:'costs_recalculation',month:`${month}-01`,cost_import_id:costSource.import_id},abort.signal);
      if(current!==generation.current||abort.signal.aborted)return;
      if(data?.format_version!=='costs-recalculation-v1')throw{code:'P0045'};
      if(!validPreview(data,costSource,`${month}-01`))throw new Error('invalid_cost_recalculation');setAnalysis(data);
    }catch(failure){if(current===generation.current&&!abort.signal.aborted)setError(productCostError(failure,'Não foi possível conferir o impacto dos custos no fechamento. Analise novamente.'));}
    finally{if(current===generation.current)setBusy(null);}
  }
  async function execute(body:CostRecalculationBody) {
    if(disabled||busy)return;const current=generation.current;setBusy('commit');setError('');
    try{const result=await productCostRequest<{format_version:string;import_id:string;source_import_id:string;cost_import_id:string;request_id:string;month:string;row_count:number;idempotent?:boolean}>(body);
      if(current!==generation.current)return;
      if(result?.format_version!=='costs-recalculation-v1'||!costUuid(result.import_id)||result.cost_import_id!==body.cost_import_id||result.source_import_id!==body.previous_import_id||result.request_id!==body.request_id||result.month!==body.month||result.row_count!==analysis?.row_count)throw new Error('unconfirmed_cost_recalculation');
      setPending(null);setAnalysis(null);setReviewed(false);setSuccess(`${result.idempotent?'Esta aplicação já estava registrada':'Custos aplicados e margens recalculadas'}: ${result.row_count.toLocaleString('pt-BR')} itens em ${month.split('-').reverse().join('/')}. A nova versão está disponível em Faturamento e Fechamento → Margens; o fechamento anterior e os arquivos originais permanecem no histórico.`);onApplied?.();
    }catch(failure){if(current===generation.current){const code=failure&&typeof failure==='object'&&'code'in failure?String(failure.code):'';
      if(['40001','22023','22003','23514','42501','P0045','PGRST202','PGRST301','PGRST303'].includes(code)){setPending(null);setReviewed(false);setAnalysis(null);}
      else setPending(body);setError(productCostError(failure,'A confirmação da aplicação não chegou. O mês, a base de custos e o protocolo foram preservados. Confira o mesmo envio pela confirmação pendente.'));
    }}finally{if(current===generation.current)setBusy(null);}
  }
  const frozen=disabled||!!busy||!!pending, totals=analysis?.totals;
  return <section className="panel cost-closing-application stack" aria-labelledby="cost-application-title"><div><h2 id="cost-application-title">Aplicar custos ao fechamento</h2><p className="muted">Base selecionada: {costSource.file_name} · Referência {dateLabel(costSource.reference_date)}</p></div>
    <p className="notice">Novo CMV = custo unitário × quantidade do item. A margem usa venda − novo CMV − frete − imposto − comissão informados no fechamento. O cálculo arredonda o CMV de cada linha para centavos e mantém os custos unitários completos.</p>
    <form className="form-grid" onSubmit={event=>void analyze(event)}><label className="field">Mês do fechamento para aplicar custos<input type="month" min="1900-01" max="2199-12" required value={month} disabled={frozen} onChange={event=>{generation.current++;controller.current?.abort();setMonth(event.target.value);setAnalysis(null);setReviewed(false);setError('');setSuccess('');setPage(0);}}/></label><div className="inline-actions"><button className="button secondary" disabled={frozen||!month}>{busy==='preview'?'Conferindo impacto…':'Analisar impacto dos custos'}</button></div></form>
    {error&&<p className="notice error" role="alert">{error}</p>}{success&&<p className="notice success" role="status">{success}</p>}
    {pending&&<div className="notice"><p>A aplicação está pendente de confirmação. Mantenha esta tela para conferir o mesmo protocolo.</p><button className="button secondary" disabled={disabled||!!busy} onClick={()=>void execute(pending)}>Repetir aplicação pendente</button></div>}
    {analysis&&totals&&<><h3>Impacto no fechamento · {month.split('-').reverse().join('/')}</h3><p className="help-text">{analysis.source?.file_name||'Nenhum fechamento disponível para este mês.'} · {analysis.row_count.toLocaleString('pt-BR')} itens · {analysis.matched_count.toLocaleString('pt-BR')} códigos encontrados na base de custos.</p>
      <dl className="cost-application-summary"><div><dt>CMV atual do fechamento</dt><dd>{cash(totals.previous_cost_cents)}</dd></div><div><dt>Novo CMV com a base de custos</dt><dd>{cash(totals.new_cost_cents)}</dd></div><div><dt>Margem atual do fechamento</dt><dd>{cash(totals.previous_margin_cents)}</dd></div><div><dt>Margem recalculada</dt><dd>{cash(totals.new_margin_cents)}</dd></div></dl>
      {analysis.already_applied ? <p className="notice success" role="status">Os custos desta base já estão aplicados a este fechamento. A versão existente está preservada.</p> : !analysis.source ? <p className="notice" role="status">Importe primeiro o fechamento deste mês em Fechamento / Faturamento para aplicar a base de custos.</p> : !analysis.can_apply&&<p className="notice error" role="alert">A aplicação está bloqueada. Confira os itens indicados: código e quantidade precisam estar informados, o custo deve ser maior que zero e os demais componentes da margem devem estar disponíveis.</p>}
      <div className="table-wrap"><table><caption>Conferência do CMV e da margem por item</caption><thead><tr><th>Linha / código</th><th>Produto / NF</th><th>Quantidade</th><th>Custo unitário</th><th>CMV atual</th><th>Novo CMV</th><th>Nova margem</th><th>Conferência</th></tr></thead><tbody>{analysis.rows.slice(page*20,(page+1)*20).map(row=><tr key={row.id}><td>{row.line_number} · {row.code||'Sem código'}</td><td>{row.product}<small className="help-text">NF {row.invoice||'não informada'} · Filial {row.branch}</small></td><td>{row.quantity===null?'Não informada':row.quantity.replace('.',',')}</td><td>{displayUnitCost(row.unit_cost)}</td><td>{cash(row.previous_cost_cents)}</td><td>{cash(row.new_cost_cents)}</td><td>{cash(row.new_margin_cents)}</td><td>{row.error_codes.length?row.error_codes.map(problemLabel).join('; '):'Conferido'}</td></tr>)}</tbody></table></div>
      {analysis.rows.length>20&&<div className="pagination"><span>Página {page+1} de {Math.ceil(analysis.rows.length/20)}</span><button className="button secondary" disabled={frozen||!page} onClick={()=>setPage(value=>value-1)}>Itens anteriores do cálculo</button><button className="button secondary" disabled={frozen||(page+1)*20>=analysis.rows.length} onClick={()=>setPage(value=>value+1)}>Próximos itens do cálculo</button></div>}
      <label className="commercial-import-check"><input type="checkbox" checked={reviewed} disabled={frozen||!analysis.can_apply} onChange={event=>setReviewed(event.target.checked)}/>Conferi o impacto. Quero substituir o CMV e recalcular as margens deste mês em uma nova versão do fechamento.</label>
      <button className="button" disabled={frozen||!reviewed||!analysis.can_apply} onClick={()=>void execute({action:'commit',mode:'costs_recalculation',cost_import_id:costSource.import_id,month:analysis.month,previous_import_id:analysis.previous_import_id,request_id:crypto.randomUUID(),complete:true})}>{busy==='commit'?'Aplicando custos…':'Aplicar custos e recalcular margens'}</button>
    </>}
  </section>;
}
