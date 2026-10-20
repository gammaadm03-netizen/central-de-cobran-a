export type RoleKey = 'diretor' | 'gerente_geral' | 'contas_receber' | 'contas_pagar' | 'rh_dp' | 'cobradora_1' | 'cobradora_2';
export interface Profile {
  id: string;
  username: string;
  display_name: string;
  role_key: RoleKey;
  enabled: boolean;
}
export interface Access {
  profile: Profile;
  permissions: { resource: string; action: string }[];
  collector_id: string | null;
  full_import_access?: boolean;
}
export const roleNames: Record<RoleKey, string> = {
  diretor: 'Diretor', gerente_geral: 'Gerente Geral', contas_receber: 'Contas a Receber', contas_pagar: 'Contas a Pagar', rh_dp: 'RH / DP', cobradora_1: 'Cobrança 01', cobradora_2: 'Cobrança 02',
};
export function isAccess(value: unknown): value is Access {
  if (!value || typeof value !== 'object') return false;
  const access = value as Partial<Access>;
  return !!access.profile?.enabled && !!access.profile.id && access.profile.role_key in roleNames && Array.isArray(access.permissions) && access.permissions.every(permission => typeof permission.resource === 'string' && typeof permission.action === 'string');
}
export function permits(access: Access, resource: string, action = 'read') {
  if (access.profile.role_key === 'diretor' && (resource === 'importar_bases' || !['read', 'export'].includes(action))) return false;
  return access.permissions.some(permission => permission.resource === resource && permission.action === action);
}
export function hasFullImportAccess(access: Access) {
  return access.profile.role_key === 'contas_receber' && access.full_import_access === true && permits(access, 'importar_bases');
}
