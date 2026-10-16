import { ReceivableWorkspace } from './Receivables';

export default function Collections({ canWrite, canManage, collectorId, isCollector }: { canWrite: boolean; canManage: boolean; collectorId: string | null; isCollector: boolean }) {
  return <ReceivableWorkspace mode="collections" canWrite={canWrite} canManage={canManage} collectorId={collectorId} isCollector={isCollector} />;
}
