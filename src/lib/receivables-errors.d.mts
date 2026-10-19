export type ReceivableImportPhase = 'preview' | 'commit';
export interface ReceivableFailure { phase: ReceivableImportPhase; code: string; activation_required: boolean; status?: number; request_id?: string; stage?: string; schema_version?: string; errors: { line: number; column: string; problem: string; correction: string }[] }
export function makeReceivableFailure(input?: { phase?: ReceivableImportPhase; status?: unknown; code?: unknown; payload?: unknown }): ReceivableFailure;
export function receivableFailureReference(error: unknown, phase?: ReceivableImportPhase): string;
export function receivableImportFailureMessage(error: unknown, phase?: ReceivableImportPhase): string;
