import { useRef, useState, type KeyboardEvent } from 'react';
import Commercial from './Commercial';
import ProductCostsCatalog from './ProductCostsCatalog';
import CostClosingApplication from './CostClosingApplication';
import type { CostSource } from '../lib/product-costs';

const tabs = [
  { id: 'margins', label: 'Margens' },
  { id: 'costs', label: 'Custos' },
] as const;
type Tab = typeof tabs[number]['id'];

export default function Closing({ canExportMargins, canApplyCosts, onImportClosing, onImportCosts }: {
  canExportMargins: boolean;
  canApplyCosts: boolean;
  onImportClosing?: () => void;
  onImportCosts?: () => void;
}) {
  const [active, setActive] = useState<Tab>('margins');
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(['margins']));
  const [costSource, setCostSource] = useState<CostSource | null>(null);
  const [applying, setApplying] = useState(false);
  const [marginsRevision, setMarginsRevision] = useState(0);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);

  function show(id: Tab) {
    if (applying) return;
    setActive(id);
    setVisited(previous => new Set([...previous, id]));
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (applying) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    show(tabs[next].id);
    tabButtons.current[next]?.focus();
  }

  return <div className="stack">
    <div className="tabs" role="tablist" aria-label="Áreas do fechamento">
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`closing-tab-${tab.id}`} aria-controls={`closing-panel-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} disabled={applying} ref={element => { tabButtons.current[index] = element; }} onClick={() => show(tab.id)} onKeyDown={event => keyboard(event, index)}>{tab.label}</button>)}
    </div>
    <div role="tabpanel" id="closing-panel-margins" aria-labelledby="closing-tab-margins" hidden={active !== 'margins'}>
      <Commercial view="margins" canExport={canExportMargins} onImport={onImportClosing} refreshKey={marginsRevision} />
    </div>
    <div role="tabpanel" id="closing-panel-costs" aria-labelledby="closing-tab-costs" hidden={active !== 'costs'}>
      {visited.has('costs') && <div className="stack product-costs">
        {onImportCosts && <div className="inline-actions"><button type="button" className="button secondary" disabled={applying} onClick={onImportCosts}>Importar custos</button></div>}
        <ProductCostsCatalog disabled={applying} onSourceChange={setCostSource} />
        {canApplyCosts && costSource && <CostClosingApplication costSource={costSource} disabled={false} onBusyChange={setApplying} onApplied={() => setMarginsRevision(value => value + 1)} />}
      </div>}
    </div>
  </div>;
}
