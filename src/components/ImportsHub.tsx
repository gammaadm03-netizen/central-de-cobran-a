import { useState } from 'react';
import { hasFullImportAccess, permits, type Access } from '../lib/access';
import PayablesImport from './PayablesImport';
import ReceivablesImport from './ReceivablesImport';
import BankImport from './BankImport';
import StockImport from './StockImport';
import DirectorInputs from './DirectorInputs';
import CollectionReferenceImport from './CollectionReferenceImport';
import CommercialImport from './CommercialImport';
import HumanResourcesImport from './HumanResourcesImport';
import CostsImport from './CostsImport';

const areas = [
  { id: 'contas_pagar', label: 'Contas a Pagar' },
  { id: 'contas_receber', label: 'Contas a Receber' },
  { id: 'collection_references', label: 'Contatos e descrições' },
  { id: 'caixa', label: 'Caixa / Bancos' },
  { id: 'estoque', label: 'Estoque' },
  { id: 'resumo_diretoria', label: 'Resumo da Diretoria' },
  { id: 'fechamento', label: 'Fechamento / Faturamento' },
  { id: 'rh_dp', label: 'RH / DP' },
  { id: 'custos', label: 'Custos' },
];

export default function ImportsHub({ access, initialArea = 'contas_pagar', onDashboard }: { access: Access; initialArea?: string; onDashboard?: () => void }) {
  const isImportOperator = access.profile.role_key === 'gerente_geral' || hasFullImportAccess(access);
  const canWriteStock = isImportOperator && permits(access, 'caixa', 'write');
  const canWriteDirector = isImportOperator && permits(access, 'resumo_diretoria', 'write');
  const canImportReferences = ['gerente_geral', 'contas_receber'].includes(access.profile.role_key)
    && permits(access, 'importar_bases', 'read') && ['read', 'write', 'import'].every(action => permits(access, 'contas_receber', action));
  const canImportClosing = permits(access, 'fechamento', 'import') && permits(access, 'faturamento');
  const canImportHr = permits(access, 'rh_dp', 'import') && permits(access, 'rh_dp', 'write') && permits(access, 'rh_dp');
  const canImportCosts = permits(access, 'importar_bases') && permits(access, 'custos', 'import') && permits(access, 'margens');
  const available = areas.filter(area => area.id === 'collection_references' ? canImportReferences : area.id === 'estoque' ? canWriteStock : area.id === 'resumo_diretoria' ? canWriteDirector : area.id === 'fechamento' ? canImportClosing : area.id === 'rh_dp' ? canImportHr : area.id === 'custos' ? canImportCosts : permits(access, area.id, 'import'));
  const [selected, setSelected] = useState(available.find(area => area.id === initialArea)?.id ?? available[0]?.id ?? '');
  const [receivableBusy, setReceivableBusy] = useState(false);
  const active = available.find(area => area.id === selected) ?? available[0];
  if (!active) return <section className="panel"><h2>Importar Bases</h2><p className="notice">Seu perfil não permite importar bases. Consulte os módulos autorizados na navegação.</p></section>;
  return <div className="stack">
    <div className="panel"><h2>Atualização das bases oficiais</h2><p className="muted">Escolha a base que deseja atualizar. Cada área respeita as permissões do seu acesso.</p>
      <div className="tabs" role="tablist" aria-label="Bases para atualização" style={{ marginTop: 18, marginBottom: 0 }}>{available.map(area => <button type="button" role="tab" key={area.id} id={`import-tab-${area.id}`} aria-selected={active.id === area.id} aria-controls={`import-panel-${area.id}`} disabled={receivableBusy} onClick={() => { if (!receivableBusy) setSelected(area.id); }}>{area.label}</button>)}</div>
    </div>
    <div role="tabpanel" id={`import-panel-${active.id}`} aria-labelledby={`import-tab-${active.id}`} key={active.id}>
      {active.id === 'contas_pagar' ? <PayablesImport canImport /> : active.id === 'contas_receber' ? <ReceivablesImport canImport isManager={access.profile.role_key === 'gerente_geral'} currentUserId={access.profile.id} onBusyChange={setReceivableBusy} /> : active.id === 'collection_references' ? <CollectionReferenceImport canImport={canImportReferences} /> : active.id === 'caixa' ? <BankImport canImport /> : active.id === 'estoque' ? <StockImport canWrite={canWriteStock} onDashboard={onDashboard} /> : active.id === 'resumo_diretoria' ? <DirectorInputs canWrite={canWriteDirector} onDashboard={onDashboard} /> : active.id === 'fechamento' ? <CommercialImport canImport={canImportClosing} /> : active.id === 'rh_dp' ? <HumanResourcesImport canImport={canImportHr} /> : active.id === 'custos' ? <CostsImport canImport={canImportCosts} canApply={canImportClosing} /> : null}
    </div>
  </div>;
}
