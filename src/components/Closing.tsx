import { useEffect, useState } from 'react';
import Commercial from './Commercial';
import ProductCostsCatalog from './ProductCostsCatalog';
import CostClosingApplication from './CostClosingApplication';
import ClosingDashboard from './ClosingDashboard';
import type { CostSource } from '../lib/product-costs';

export type ClosingView = 'dashboard' | 'margins' | 'costs';

export default function Closing({ view, canExportMargins, canApplyCosts, onImportClosing, onImportCosts, onViewChange, onBusyChange }: {
  view: ClosingView;
  canExportMargins: boolean;
  canApplyCosts: boolean;
  onImportClosing?: () => void;
  onImportCosts?: () => void;
  onViewChange: (view: ClosingView) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [visited, setVisited] = useState<Set<ClosingView>>(() => new Set([view]));
  const [costSource, setCostSource] = useState<CostSource | null>(null);
  const [applying, setApplying] = useState(false);
  const [financialRevision, setFinancialRevision] = useState(0);
  useEffect(() => { setVisited(previous => previous.has(view) ? previous : new Set([...previous, view])); }, [view]);
  useEffect(() => { onBusyChange(applying); return () => onBusyChange(false); }, [applying, onBusyChange]);

  return <div className="stack">
    <div hidden={view !== 'dashboard'}>
      {(view === 'dashboard' || visited.has('dashboard')) && <ClosingDashboard refreshKey={financialRevision} onMargins={() => onViewChange('margins')} onCosts={() => onViewChange('costs')} onImport={onImportClosing} />}
    </div>
    <div hidden={view !== 'margins'}>
      {(view === 'margins' || visited.has('margins')) && <Commercial view="margins" canExport={canExportMargins} onImport={onImportClosing} refreshKey={financialRevision} />}
    </div>
    <div hidden={view !== 'costs'}>
      {(view === 'costs' || visited.has('costs')) && <div className="stack product-costs">
        {onImportCosts && <div className="inline-actions"><button type="button" className="button secondary" disabled={applying} onClick={onImportCosts}>Importar custos</button></div>}
        <ProductCostsCatalog disabled={applying} onSourceChange={setCostSource} />
        {canApplyCosts && costSource && <CostClosingApplication costSource={costSource} disabled={false} onBusyChange={setApplying} onApplied={() => setFinancialRevision(value => value + 1)} />}
      </div>}
    </div>
  </div>;
}
