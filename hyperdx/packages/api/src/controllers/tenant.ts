import Tenant, { ITenant } from '@/models/tenant';

export function getTenants() {
  return Tenant.find({});
}

export function getTenantById(tenantId: string) {
  return Tenant.findById(tenantId);
}

export function getTenantByApiKey(apiKey: string) {
  return Tenant.findOne({ apiKey });
}

export function getTenantBySlug(slug: string) {
  return Tenant.findOne({ slug });
}

export function createTenant(tenant: Omit<ITenant, 'id' | '_id'>) {
  return Tenant.create(tenant);
}

export function updateTenant(
  tenantId: string,
  tenant: Partial<Omit<ITenant, 'id' | '_id'>>,
) {
  return Tenant.findByIdAndUpdate(tenantId, tenant, {
    new: true,
  });
}

export function deleteTenant(tenantId: string) {
  return Tenant.findByIdAndDelete(tenantId);
}

