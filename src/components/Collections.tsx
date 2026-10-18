import { useRef, useState, type KeyboardEvent } from 'react';
import CollectionOverview, { type CollectionSelection } from './CollectionOverview';
import CollectionDesk from './CollectionDesk';
import CollectionValidation from './CollectionValidation';
import CollectionWorkTime from './CollectionWorkTime';
import CollectionContactsReport from './CollectionContactsReport';
import '../collection-central.css';

const tabs = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'titles', label: 'Títulos' },
  { id: 'validation', label: 'Validação financeira' },
  { id: 'time', label: 'Tempo de trabalho' },
  { id: 'contacts', label: 'Contatos' },
] as const;
type Tab = typeof tabs[number]['id'];

export default function Collections({ canWrite, canManage, canReadFinance = false, canValidate = false, collectorId, isCollector }: {
  canWrite: boolean; canManage: boolean; canReadFinance?: boolean; canValidate?: boolean;
  collectorId: string | null; isCollector: boolean;
}) {
  const [active, setActive] = useState<Tab>('overview');
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(['overview']));
  const [revision, setRevision] = useState(0);
  const [contactsRevision, setContactsRevision] = useState(0);
  const [selection, setSelection] = useState<(CollectionSelection & { requestId: number }) | undefined>();
  const requestId = useRef(0), tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const unbound = isCollector && !collectorId;
  function show(id: Tab) { setActive(id); setVisited(previous => new Set([...previous, id])); }
  function details(filters: CollectionSelection) { setSelection({ ...filters, requestId: ++requestId.current }); show('titles'); }
  function changed() { setRevision(value => value + 1); }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault(); show(tabs[next].id); tabButtons.current[next]?.focus();
  }
  return <div className="collections-central">
    <div className="tabs collections-central-tabs" role="tablist" aria-label="Central de cobrança">
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`collections-tab-${tab.id}`} aria-controls={`collections-panel-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} ref={element => { tabButtons.current[index] = element; }} onClick={() => show(tab.id)} onKeyDown={event => keyboard(event, index)}>{tab.label}</button>)}
    </div>
    {unbound && <p className="notice" role="status">Seu login ainda não está vinculado a uma cobradora. Peça à Gerência Geral para configurar o vínculo em Administração. Nenhuma carteira está disponível até essa configuração.</p>}
    {tabs.map(tab => <div key={tab.id} className="collections-central-panel" role="tabpanel" id={`collections-panel-${tab.id}`} aria-labelledby={`collections-tab-${tab.id}`} hidden={active !== tab.id}>
      {!unbound && visited.has(tab.id) && <>
        {tab.id === 'overview' && <CollectionOverview isCollector={isCollector} collectorId={collectorId} refreshKey={revision} onDetails={details} onRefresh={changed} />}
        {tab.id === 'titles' && <CollectionDesk canWrite={canWrite} canManage={canManage} collectorId={collectorId} isCollector={isCollector} selection={selection} refreshKey={revision} contactsRefreshKey={contactsRevision} onContactsChange={() => setContactsRevision(value => value + 1)} onChange={changed} onFinish={paid => { if (paid) show('validation'); }} />}
        {tab.id === 'validation' && <CollectionValidation canRead canReadFinance={canReadFinance} canWrite={canManage} canValidate={canValidate} isCollector={isCollector} collectorId={collectorId} refreshKey={revision} onChange={changed} />}
        {tab.id === 'time' && <CollectionWorkTime isCollector={isCollector} collectorId={collectorId} refreshKey={revision} />}
        {tab.id === 'contacts' && <CollectionContactsReport isCollector={isCollector} collectorId={collectorId} refreshKey={revision + contactsRevision} />}
      </>}
    </div>)}
  </div>;
}
