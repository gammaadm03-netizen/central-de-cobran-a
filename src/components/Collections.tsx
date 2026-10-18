import { useRef, useState } from 'react';
import { ReceivableWorkspace } from './Receivables';
import CollectionOverview, { type CollectionSelection } from './CollectionOverview';

export default function Collections({ canWrite, canManage, collectorId, isCollector }: { canWrite: boolean; canManage: boolean; collectorId: string | null; isCollector: boolean }) {
  const [summaryRefresh, setSummaryRefresh] = useState(0), [workspaceRefresh, setWorkspaceRefresh] = useState(0);
  const [selection, setSelection] = useState<(CollectionSelection & { requestId: number }) | undefined>();
  const requestId = useRef(0), workspace = useRef<HTMLDivElement | null>(null);
  function details(filters: CollectionSelection) {
    setSelection({ ...filters, requestId: ++requestId.current });
    workspace.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  return <>
    {!(isCollector && !collectorId) && <CollectionOverview isCollector={isCollector} collectorId={collectorId} refreshKey={summaryRefresh} onDetails={details} onRefresh={() => { setSummaryRefresh(value => value + 1); setWorkspaceRefresh(value => value + 1); }} />}
    <div ref={workspace}><ReceivableWorkspace mode="collections" canWrite={canWrite} canManage={canManage} collectorId={collectorId} isCollector={isCollector} collectionFilter={selection} refreshKey={workspaceRefresh} onCollectionChange={() => setSummaryRefresh(value => value + 1)} /></div>
  </>;
}
