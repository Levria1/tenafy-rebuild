import axios from 'axios';
import Cookies from 'js-cookie';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = Cookies.get('__s_t');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      Cookies.remove('__s_t');
      if (typeof window !== 'undefined') {
        // Redirect master admin to master login, org users to normal login
        const isMasterPage = window.location.pathname.startsWith('/master');
        window.location.href = isMasterPage ? '/master/login' : '/login';
      }
    }
    return Promise.reject(error);
  }
);

export const auth = {
  login: (data) => api.post('/api/auth/login', data),
  logout: () => api.post('/api/auth/logout'),
  register: (data) => api.post('/api/auth/register', data),
  forgetPassword: (data) => api.post('/api/auth/forget-password/initialize', data),
  validateCode: (data) => api.post('/api/auth/forget-password/validate', data),
  resetPassword: (data) => api.post('/api/auth/forget-password/reset', data),
  changePassword: (data) => api.post('/api/auth/password/change', data),
};

export const user = {
  getProfile: () => api.get('/api/user/profile'),
  updatePersonal: (data) => api.put('/api/user/personal', data),
  getSettings: () => api.get('/api/user/setting'),
  getDashboard: (params) => api.get('/api/user/dashboard', { params }),
  updateDashboard: (data) => api.put('/api/user/dashboard', data),
  listUsers: (data, params) => api.post('/api/user/list', data, { params }),
  createUser: (data) => api.post('/api/user', data),
  updateUser: (id, data) => api.put(`/api/user/${id}`, data),
  deleteUser: (id) => api.delete(`/api/user/${id}`),
  getUser: (id) => api.get(`/api/user/${id}`),
};

// Several components historically imported the user API as `userApi`. Both
// names point to the same object — kept aliased so existing callers don't
// break. Use either; new code can use `user`.
export const userApi = user;

// Xero integration. `connect` is NOT an axios call — it's a full-page redirect
// (the browser must follow Xero's OAuth flow), so we expose a URL builder
// instead. Other endpoints are normal API calls.
export const xero = {
  connectUrl: () => '/api/integrations/xero/connect',
  status: () => api.get('/api/integrations/xero/status'),
  disconnect: () => api.post('/api/integrations/xero/disconnect'),
  // Account mapping — Xero bank accounts ↔ Tenafy account_setting rows.
  getAccounts: () => api.get('/api/integrations/xero/accounts'),
  saveAccountMap: (mappings) => api.post('/api/integrations/xero/accounts/map', { mappings }),
  // Balance comparison: Tenafy account balance vs Xero closing balance.
  getBalances: () => api.get('/api/integrations/xero/balances'),
  // Sync + review queue.
  sync: (body) => api.post('/api/integrations/xero/sync', body || {}),
  getPending: (params) => api.get('/api/integrations/xero/pending', { params }),
  approvePending: (id, overrides) => api.post(`/api/integrations/xero/pending/${id}/approve`, overrides || {}),
  getInvoiceCandidates: (pendingId, search, direction) =>
    api.get(`/api/integrations/xero/pending/${pendingId}/invoice-candidates`, {
      params: { ...(search ? { search } : {}), ...(direction ? { direction } : {}) },
    }),
  skipPending: (id) => api.post(`/api/integrations/xero/pending/${id}/skip`),
  // Bulk actions. bulkApprove items: [{ id, account_id?, category_id?, ... }]
  bulkApprovePending: (items) => api.post('/api/integrations/xero/pending/bulk-approve', { items }),
  bulkSkipPending: (ids) => api.post('/api/integrations/xero/pending/bulk-skip', { ids }),
  // Categorization rules.
  getRules: () => api.get('/api/integrations/xero/rules'),
  createRule: (data) => api.post('/api/integrations/xero/rules', data),
  updateRule: (id, data) => api.put(`/api/integrations/xero/rules/${id}`, data),
  deleteRule: (id) => api.delete(`/api/integrations/xero/rules/${id}`),
};

export const property = {
  list: (data, params) => api.post('/api/property/list', data, { params }),
  summary: () => api.get('/api/property/summary'),
  getAll: () => api.get('/api/property/all'),
  getAllWithUnits: () => api.get('/api/property/all/with_units'),
  get: (id) => api.get(`/api/property/${id}`),
  getBase: (id) => api.get(`/api/property/${id}/base`),
  create: (data) => api.post('/api/property', data),
  update: (id, data) => api.put(`/api/property/${id}`, data),
  delete: (id) => api.delete(`/api/property/${id}`),
  clone: (id) => api.get(`/api/property/${id}/clone`),
  // Unit methods
  getUnits: (propertyId, opts = {}) => api.get(`/api/property/${propertyId}/unit`, { params: opts.showInactive ? { show_inactive: 1 } : {} }),
  getUnit: (unitId) => api.get(`/api/property/unit/${unitId}`),
  getUnitBasic: (unitId) => api.get(`/api/property/unit/${unitId}/basic`),
  createUnit: (propertyId, data) => api.post(`/api/property/${propertyId}/unit`, data),
  updateUnit: (unitId, data) => api.put(`/api/property/unit/${unitId}`, data),
  deleteUnit: (unitId) => api.delete(`/api/property/unit/${unitId}`),
  cloneUnit: (unitId) => api.get(`/api/property/unit/${unitId}/clone`),
  getUnoccupiedUnits: () => api.get('/api/property/unit/unoccupied'),
  getOccupancyRate: () => api.get('/api/property/unit/active/occupancy/rate'),
  getUnitsNoLease: (params) => api.get('/api/property/unit/nolease/within5days', { params }),
  getUnitByTenant: (tenantId) => api.get(`/api/property/unit/tenant/${tenantId}`),
  // Inventory methods
  getInventory: (unitId, params) => api.get(`/api/property/unit/${unitId}/inventory`, { params }),
  createInventory: (unitId, data) => api.post(`/api/property/unit/${unitId}/inventory`, data),
  getInventoryItem: (id) => api.get(`/api/property/unit/inventory/${id}`),
  updateInventoryItem: (id, data) => api.put(`/api/property/unit/inventory/${id}`, data),
  deleteInventoryItem: (id) => api.delete(`/api/property/unit/inventory/${id}`),
  getInventorySum: (unitId) => api.get(`/api/property/unit/${unitId}/inventory/sum`),
  getInventoryHistory: (unitId, data, params) => api.post(`/api/property/unit/${unitId}/inventory/history`, data, { params }),
  // Maintenance methods
  getMaintenanceList: (unitId) => api.get(`/api/property/unit/${unitId}/maintenance`),
  getMaintenanceSum: (unitId) => api.get(`/api/property/unit/${unitId}/maintenance/sum`),
  createMaintenance: (unitId, data) => api.post(`/api/property/unit/${unitId}/maintenance`, data),
  getMaintenance: (id) => api.get(`/api/property/unit/maintenance/${id}/detail`),
  updateMaintenance: (id, data) => api.put(`/api/property/unit/maintenance/${id}`, data),
  deleteMaintenance: (id) => api.delete(`/api/property/unit/maintenance/${id}`),
  // Property amenity methods
  getOrgPropertyAmenities: (type) => api.get('/api/property/amenities/list', { params: { type } }),
  getOrgUnitAmenities: (type) => api.get('/api/property/amenities/list', { params: { type, category: 1 } }),
  getPropertyAmenities: (id) => api.get(`/api/property/${id}/amenities`),
  updatePropertyAmenities: (id, data) => api.put(`/api/property/${id}/amenities`, data),
  // Unit amenity methods
  getUnitAmenities: (unitId) => api.get(`/api/property/unit/${unitId}/amenities`),
  updateUnitAmenities: (unitId, data) => api.put(`/api/property/unit/${unitId}/amenities`, data),
  // Furnishing methods
  getFurnishing: (unitId, params) => api.get(`/api/property/unit/${unitId}/furnishing`, { params }),
  createFurnishing: (unitId, data) => api.post(`/api/property/unit/${unitId}/furnishing`, data),
  updateFurnishing: (id, data) => api.put(`/api/property/unit/furnishing/${id}`, data),
  deleteFurnishing: (id) => api.delete(`/api/property/unit/furnishing/${id}`),
  // Lease + Services for unit
  getUnitCurrentLease: (unitId) => api.get(`/api/property/unit/${unitId}/current-lease`),
  getUnitServices: (unitId, params) => api.get(`/api/property/unit/${unitId}/services`, { params }),
  getUnitServiceCosts: (unitId, data, params) => api.post(`/api/property/unit/${unitId}/service-costs`, data, { params }),
  getUnitPropertyInfo: (unitId) => api.get(`/api/property/unit/${unitId}/property-info`),
  updateLeasingCost: (id, leasing_cost) => api.patch(`/api/property/${id}/leasing-cost`, { leasing_cost }),
};

export const tenant = {
  list: (data, params) => api.post('/api/tenant/contacts', data, { params }),
  getAll: (params) => api.get('/api/tenant/tenants', { params }),
  get: (id) => api.get(`/api/tenant/${id}`),
  getProfile: (id) => api.get(`/api/tenant/${id}/profile`),
  getProfileSum: (id) => api.get(`/api/tenant/${id}/profile/sum`),
  create: (data) => api.post('/api/tenant', data),
  update: (id, data) => api.put(`/api/tenant/${id}/profile`, data),
  // Email-only update. Do NOT use `update` for this — that endpoint overwrites
  // every column, so a partial body would null out the contact's name/phone.
  updateEmail: (id, email) => api.patch(`/api/tenant/${id}/email`, { email }),
  delete: (id) => api.delete(`/api/tenant/${id}`),
  getLeases: (id) => api.get(`/api/tenant/${id}/leases`),
  getLeasesSum: (id) => api.get(`/api/tenant/${id}/leases/sum`),
  getAccountingList: (id, data, params) => api.post(`/api/tenant/${id}/accounting/list`, data, { params }),
  getAccountingSum: (id, data) => api.post(`/api/tenant/${id}/accounting/sum`, data),
  getOutstanding: () => api.get('/api/tenant/outstanding'),
  // Smart Extract — multipart POST with optional `text` and optional `image`.
  // Server runs OCR + LLM and returns { fields, raw_text }. The image is
  // processed in memory and discarded; nothing persists server-side.
  parse: (formData) => api.post('/api/tenant/parse', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
};

export const leasing = {
  list: (data, params) => api.post('/api/leasing/list', data, { params }),
  getExpiring: (params) => api.get('/api/leasing/list/expiring', { params }),
  get: (id) => api.get(`/api/leasing/${id}`),
  create: (data) => api.post('/api/leasing', data),
  update: (id, data) => api.put(`/api/leasing/${id}`, data),
  delete: (id) => api.delete(`/api/leasing/${id}`),
  // Flip lease_state from 'pending' to 'active'. Server re-runs the overlap
  // check and generates deferred rent + deposit invoices.
  confirm: (id) => api.post(`/api/leasing/${id}/confirm`),
  // Manually send the check-in email now (bypasses toggle + date window).
  sendCheckin: (id) => api.post(`/api/leasing/${id}/send-checkin`),
  // Scheduled rate changes (lease_revision rows)
  listRevisions: (id) => api.get(`/api/leasing/${id}/revisions`),
  createRevision: (id, data) => api.post(`/api/leasing/${id}/revisions`, data),
  updateRevision: (id, rid, data) => api.put(`/api/leasing/${id}/revisions/${rid}`, data),
  deleteRevision: (id, rid) => api.delete(`/api/leasing/${id}/revisions/${rid}`),
  getTenants: () => api.get('/api/leasing/tenant/list'),
  getUnitLease: (unitId) => api.get(`/api/leasing/unit/lease/${unitId}`),
  getSumAmount: (id) => api.get(`/api/leasing/sum_amount/${id}`),
  getInvoiceSchedule: () => api.get('/api/leasing/invoice/schedule'),
  getUnits: (data) => api.post('/api/leasing/unit', data),
  getAvailableUnits: (data) => api.post('/api/leasing/unit/available', data),
  checkConflict: (data) => api.post('/api/leasing/check-conflict', data),
  getCalendar: (params) => api.get('/api/leasing/calendar', { params }),
  getSettlement: (id) => api.get(`/api/leasing/${id}/settlement`),
  saveSettlementNotes: (id, notes) => api.put(`/api/leasing/${id}/settlement-notes`, { notes }),
};

export const accounting = {
  list: (data, params) => api.post('/api/accounting/accounts', data, { params }),
  getLines: (data, params) => api.post('/api/accounting/account/lines', data, { params }),
  get: (id) => api.get(`/api/accounting/account/${id}`),
  create: (data) => api.post('/api/accounting/account', data),
  update: (id, data) => api.put(`/api/accounting/account/${id}`, data),
  delete: (id) => api.delete(`/api/accounting/account/${id}`),
  getInflowOutflow: (data) => api.post('/api/accounting/account/inflow-outflow', data),
  getBalanceNoFilter: (data) => api.post('/api/accounting/account/balance-no-filter', data),
  getPropertyGraph: (propertyId, params) => api.get(`/api/accounting/invoice/property/graph/${propertyId}`, { params }),
  getOwnerPaidOutstanding: (data) => api.post('/api/accounting/owner/paid-outstanding', data),
  getCategories: () => api.get('/api/accounting/settings/categories'),
  getAccounts: () => api.get('/api/accounting/settings/accounts'),
  getPaymentMethods: () => api.get('/api/accounting/settings/payment-methods'),
};

export const invoice = {
  list: (data, params) => api.post('/api/invoice/invoices', data, { params }),
  get: (id) => api.get(`/api/invoice/${id}`),
  getByCode: (invoiceCode) => api.get('/api/invoice/code', { params: { invoiceCode } }),
  create: (data) => api.post('/api/invoice', data),
  publish: (data) => api.post('/api/invoice/publish', data),
  publishPreview: (params) => api.get('/api/invoice/publish-preview', { params }),
  update: (id, data) => api.put(`/api/invoice/${id}`, data),
  delete: (id) => api.delete(`/api/invoice/${id}`),
  emailToTenant: (id) => api.post(`/api/invoice/${id}/email-to-tenant`),
  getSums: (data) => api.post('/api/invoice/paid-outstanding', data),
  getInitializationPayer: (params) => api.get('/api/invoice/initialization-payer', { params }),
  getInitializationProperty: (params) => api.get('/api/invoice/initialization-property', { params }),
  getInitializationLeasing: (params) => api.get('/api/invoice/initialization-leasing', { params }),
  getInitializationUnit: (params) => api.get('/api/invoice/initialization-unit', { params }),
  getPropertyByUnit: (unitId) => api.get(`/api/invoice/property/${unitId}`),
};

export const service = {
  list: (data, params) => api.post('/api/service/list', data, { params }),
  listByStatus: (data) => api.post('/api/service/list/status', data),
  get: (id) => api.get(`/api/service/detail/${id}`),
  create: (data) => api.post('/api/service/create', data),
  update: (id, data) => api.put(`/api/service/update/${id}`, data),
  patch: (id, data) => api.patch(`/api/service/patch/${id}`, data),
  delete: (id) => api.delete(`/api/service/delete/${id}`),
  getCategories: () => api.get('/api/service/category'),
  getVendors: () => api.get('/api/service/vendor/list'),
  getContacts: () => api.get('/api/service/contacts'),
  getPropertyList: () => api.get('/api/service/property/list'),
  getUnitsByProperty: (propertyId) => api.get(`/api/service/property/${propertyId}/unit`),
  getUnitById: (unitId) => api.get(`/api/service/property/unit/${unitId}`),
  getInvoiceList: (id, params) => api.get('/api/service/invoice/list', { params: { id, ...params } }),
  addActivity: (data) => api.post('/api/service/activity', data),
  deleteActivity: (id) => api.delete(`/api/service/activity/${id}`),
};

export const contact = {
  // Property owners
  listPropertyOwners: (data, params) => api.post('/api/contact/contacts/property-owner', data, { params }),
  getAllPropertyOwners: () => api.get('/api/contact/contacts/property-owner/all'),
  getPropertyOwner: (id) => api.get(`/api/property-owner/${id}`),
  createPropertyOwner: (data) => api.post('/api/property-owner', data),
  updatePropertyOwner: (id, data) => api.put(`/api/property-owner/${id}/update`, data),
  deletePropertyOwner: (id) => api.delete(`/api/property-owner/${id}`),
  // Service vendors
  listServiceVendors: (data, params) => api.post('/api/contact/contacts/service-vendor', data, { params }),
  getServiceVendor: (id) => api.get(`/api/service-vendor/${id}`),
  createServiceVendor: (data) => api.post('/api/service-vendor', data),
  updateServiceVendor: (id, data) => api.put(`/api/service-vendor/${id}/update`, data),
  deleteServiceVendor: (id) => api.delete(`/api/service-vendor/${id}`),
  getVendorServices: (id, data, params) => api.post(`/api/service-vendor/services/${id}`, data || {}, { params }),
  // Email groups
  listEmailGroups: (data, params) => api.post('/api/contact/email/groups', data, { params }),
  getEmailGroupEmails: (params) => api.get('/api/contact/email/groups/emails', { params }),
  getEmailGroupEmailsById: (id) => api.get(`/api/contact/email/groups/emails/${id}`),
  getEmailGroup: (id) => api.get(`/api/contact/email/group/${id}`),
  createEmailGroup: (data) => api.post('/api/contact/email/group', data),
  updateEmailGroup: (id, data) => api.put(`/api/contact/email/group/${id}`, data),
  deleteEmailGroup: (id) => api.delete(`/api/contact/email/group/${id}`),
  sendEmail: (data) => api.post('/api/contact/email/send', data),
  // Payees
  listPayees: (data, params) => api.post('/api/contact/contacts/payee', data, { params }),
  getPayee: (id) => api.get(`/api/payee/${id}`),
  createPayee: (data) => api.post('/api/payee', data),
  updatePayee: (id, data) => api.put(`/api/payee/${id}/update`, data),
  deletePayee: (id) => api.delete(`/api/payee/${id}`),
  // Property owner tags
  getAllTags: () => api.get('/api/contact/contacts/property-owner/tag/all'),
  createTag: (data) => api.post('/api/contact/contacts/property-owner/tag', data),
  deleteTag: (id) => api.delete(`/api/contact/contacts/property-owner/tag/${id}`),
  getOwnerTags: (ownerId) => api.get(`/api/contact/property-owner/tag/${ownerId}`),
  addOwnerTag: (ownerId, data) => api.post(`/api/contact/property-owner/tag/${ownerId}`, data),
  // User invitations
  checkTenantUser: (data) => api.post('/api/contact/tenant/check/user', data),
  createTenantUser: (data) => api.post('/api/contact/tenant/create/user', data),
  checkOwnerUser: (data) => api.post('/api/contact/property-owner/check/user', data),
  createOwnerUser: (data) => api.post('/api/contact/property-owner/create/user', data),
};

export const role = {
  list: (data, params) => api.post('/api/role/list', data, { params }),
  get: (id) => api.get(`/api/role/${id}`),
  create: (data) => api.post('/api/role', data),
  update: (id, data) => api.put(`/api/role/${id}`, data),
  delete: (id) => api.delete(`/api/role/${id}`),
  getAll: () => api.get('/api/role/all'),
  getPermissions: () => api.get('/api/role/permissions'),
};

export const amenity = {
  list: (data, params) => api.post('/api/amenity/list', data, { params }),
  get: (id) => api.get(`/api/amenity/${id}`),
  create: (data) => api.post('/api/amenity', data),
  update: (id, data) => api.put(`/api/amenity/${id}`, data),
  delete: (id) => api.delete(`/api/amenity/${id}`),
};

export const smtpAccount = {
  list: () => api.post('/api/smtp-account/list'),
  create: (data) => api.post('/api/smtp-account', data),
  update: (id, data) => api.put(`/api/smtp-account/${id}`, data),
  delete: (id) => api.delete(`/api/smtp-account/${id}`),
  test: (data) => api.post('/api/smtp-account/test', data),
};

export const emailTemplate = {
  list: (data, params) => api.post('/api/email-template/list', data, { params }),
  getAll: (params) => api.get('/api/email-template/all', { params }),
  getTypes: () => api.get('/api/email-template/types/get'),
  getVariables: () => api.get('/api/email-template/variable/get'),
  get: (id) => api.get(`/api/email-template/${id}`),
  create: (data) => api.post('/api/email-template', data),
  update: (id, data) => api.put(`/api/email-template/${id}`, data),
  delete: (id) => api.delete(`/api/email-template/${id}`),
  send: (data) => api.post('/api/email-template/send', data),
  preview: (data) => api.post('/api/email-template/preview', data),
};

export const whatsappTemplate = {
  list: (data, params) => api.post('/api/whatsapp-template/list', data, { params }),
  getAll: (params) => api.get('/api/whatsapp-template/all', { params }),
  getTypes: () => api.get('/api/whatsapp-template/types/get'),
  getVariables: () => api.get('/api/whatsapp-template/variable/get'),
  get: (id) => api.get(`/api/whatsapp-template/${id}`),
  create: (data) => api.post('/api/whatsapp-template', data),
  update: (id, data) => api.put(`/api/whatsapp-template/${id}`, data),
  delete: (id) => api.delete(`/api/whatsapp-template/${id}`),
  send: (data) => api.post('/api/whatsapp-template/send', data),
  preview: (data) => api.post('/api/whatsapp-template/preview', data),
  ping: () => api.get('/api/whatsapp-template/connection/ping'),
};

export const inquiry = {
  list: (params) => api.get('/api/inquiry/list', { params }),
  get: (id) => api.get(`/api/inquiry/${id}`),
  create: (data) => api.post('/api/inquiry', data),
  update: (id, data) => api.put(`/api/inquiry/${id}`, data),
  delete: (id) => api.delete(`/api/inquiry/${id}`),
  linkContact: (id, tenantId) => api.post(`/api/inquiry/${id}/link-contact`, { tenant_id: String(tenantId) }),
  // Smart-extract: POST multipart with `text` and/or `image`. Returns
  // { fields: {...}, screenshot_url, raw_text }. The fields prefill the
  // form; screenshot_url is stored alongside the inquiry on save.
  parse: (formData) => api.post('/api/inquiry/parse', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
};

// E-signature — admin + public surfaces. The /sign/[token] public page uses
// the same axios instance but its endpoints don't require auth.
export const signature = {
  // Landlord signatures (Settings)
  listLandlordSigs: () => api.get('/api/signature/landlord-signatures'),
  createLandlordSig: (data) => api.post('/api/signature/landlord-signatures', data),
  updateLandlordSig: (id, data) => api.put(`/api/signature/landlord-signatures/${id}`, data),
  deleteLandlordSig: (id) => api.delete(`/api/signature/landlord-signatures/${id}`),
  // Requests (admin)
  createRequest: (data) => api.post('/api/signature/request', data),
  getRequest: (id) => api.get(`/api/signature/request/${id}`),
  cancelRequest: (id) => api.post(`/api/signature/request/${id}/cancel`),
  resendRequest: (id) => api.post(`/api/signature/request/${id}/resend`),
  listForLease: (leaseId) => api.get(`/api/signature/lease/${leaseId}`),
  // Public (signer)
  getPublic: (token) => api.get(`/api/signature/public/${token}`),
  sign: (token, data) => api.post(`/api/signature/public/${token}/sign`, data),
  decline: (token, data) => api.post(`/api/signature/public/${token}/decline`, data),
  publicPdfUrl: (token) => `/api/signature/public/${token}/pdf`,
};

// Lease templates — Quill HTML stored with {{VARIABLES}} substituted server-side
// at preview/generate time via Puppeteer (services/leasePdfRenderer.js).
export const leaseTemplate = {
  list: () => api.get('/api/lease-template/list'),
  get: (id) => api.get(`/api/lease-template/${id}`),
  create: (data) => api.post('/api/lease-template', data),
  update: (id, data) => api.put(`/api/lease-template/${id}`, data),
  remove: (id) => api.delete(`/api/lease-template/${id}`),
  duplicate: (id) => api.post(`/api/lease-template/${id}/duplicate`),
  setDefault: (id) => api.post(`/api/lease-template/${id}/set-default`),
  variables: () => api.get('/api/lease-template/variables'),
  // Inline preview from raw editor HTML (BEFORE save) → PDF blob.
  previewInline: (payload) => api.post('/api/lease-template/preview', payload, { responseType: 'blob' }),
  // Preview of an already-saved template → PDF blob.
  previewSaved: (id) => api.post(`/api/lease-template/${id}/preview`, {}, { responseType: 'blob' }),
};

export const settings = {
  // Categories
  getCategories: () => api.get('/api/user/setting/category/list'),
  getCategoriesPaged: (params) => api.get('/api/user/setting/category/page/list', { params }),
  getTenantCategories: () => api.get('/api/user/setting/category/list/tenant'),
  createCategory: (data) => api.post('/api/user/setting/category/add', data),
  updateCategory: (id, data) => api.put(`/api/user/setting/category/update/${id}`, data),
  deleteCategory: (id) => api.delete(`/api/user/setting/category/delete/${id}`),
  // Payment methods
  getPaymentMethods: () => api.get('/api/user/setting/payment/list'),
  createPaymentMethod: (data) => api.post('/api/user/setting/payment/add', data),
  updatePaymentMethod: (id, data) => api.put(`/api/user/setting/payment/update/${id}`, data),
  deletePaymentMethod: (id) => api.delete(`/api/user/setting/payment/delete/${id}`),
  // Lead sources
  getLeadSources: () => api.get('/api/user/setting/lead-source/list'),
  createLeadSource: (data) => api.post('/api/user/setting/lead-source/add', data),
  updateLeadSource: (id, data) => api.put(`/api/user/setting/lead-source/update/${id}`, data),
  deleteLeadSource: (id) => api.delete(`/api/user/setting/lead-source/delete/${id}`),
  // Landlord / org settings
  getLandlord: () => api.get('/api/user/setting/landlord'),
  updateLandlord: (data) => api.put('/api/user/setting/landlord/update', data),
  getCurrency: () => api.get('/api/user/setting/currency'),
  getCountries: () => api.get('/api/user/setting/country'),
  getExchangeRate: () => api.get('/api/user/setting/exchange-rate'),
  updateExchangeRate: (params) => api.put('/api/user/setting/landlord/exchange-rate/update', null, { params }),
  getExchangeRateHistory: (params) => api.get('/api/user/setting/landlord/exchange-rate/history', { params }),
  // Sequences
  getSequences: () => api.get('/api/user/setting/sequences'),
  updateSequence: (id, data) => api.put(`/api/user/setting/sequence/${id}`, data),
  // Account settings
  getAccountSettings: () => api.get('/api/user/setting/account/list'),
  getAccountSettingsPaged: (params) => api.get('/api/user/setting/account/page/list', { params }),
  createAccountSetting: (data) => api.post('/api/user/setting/account/add', data),
  updateAccountSetting: (id, data) => api.put(`/api/user/setting/account/update/${id}`, data),
  deleteAccountSetting: (id) => api.delete(`/api/user/setting/account/delete/${id}`),
  // Email settings (whitelist)
  getEmailSettings: () => api.get('/api/user/setting/email'),
  updateEmailSettings: (data) => api.put('/api/user/setting/email', data),
  getWhatsAppSettings: () => api.get('/api/user/setting/whatsapp'),
  updateWhatsAppSettings: (data) => api.put('/api/user/setting/whatsapp', data),
  clearWhatsAppKey: () => api.delete('/api/user/setting/whatsapp/key'),
  // API Keys
  checkApiEnabled: () => api.get('/api/user/setting/api-keys/enabled'),
  getApiKeys: () => api.get('/api/user/setting/api-keys'),
  createApiKey: (data) => api.post('/api/user/setting/api-keys', data),
  updateApiKey: (id, data) => api.put(`/api/user/setting/api-keys/${id}`, data),
  deleteApiKey: (id) => api.delete(`/api/user/setting/api-keys/${id}`),
};

export const pdf = {
  // Returns URL string — open in new tab or use as href for direct streaming
  invoiceUrl: (id) => `${API_URL}/api/pdf/invoice/${id}`,
  leaseUrl: (id) => `${API_URL}/api/pdf/lease/${id}`,
  receiptUrl: (paymentId) => `${API_URL}/api/pdf/receipt/${paymentId}`,
  // Fetch as blob (for download with custom filename)
  fetchInvoice: (id) => api.get(`/api/pdf/invoice/${id}`, { responseType: 'blob' }),
  fetchLease: (id) => api.get(`/api/pdf/lease/${id}`, { responseType: 'blob' }),
  fetchReceipt: (paymentId) => api.get(`/api/pdf/receipt/${paymentId}`, { responseType: 'blob' }),
};

export const file = {
  upload: (formData) => api.post('/api/file/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  uploadImage: (formData) => api.post('/api/file/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  preview: (id) => `${API_URL}/api/file/preview/${id}`,
  download: (id) => `${API_URL}/api/file/download/${id}`,
};

export const accountingApi = {
  getCategories: () => api.get('/api/accounting/settings/categories'),
  getAccounts: () => api.get('/api/accounting/settings/accounts'),
  getPaymentMethods: () => api.get('/api/accounting/settings/payment-methods'),
  getLines: (data, params) => api.post('/api/accounting/account/lines', data, { params }),
};

export const notification = {
  list: (params) => api.get('/api/notification/list', { params }),
  getRecent: () => api.get('/api/notification/recent'),
  getUnreadCount: () => api.get('/api/notification/unread-count'),
  markRead: (id) => api.put(`/api/notification/${id}/read`),
  markAllRead: () => api.put('/api/notification/read-all'),
  delete: (id) => api.delete(`/api/notification/${id}`),
};

export const activityLog = {
  list: (params) => api.get('/api/activity-log/list', { params }),
  getUsers: () => api.get('/api/activity-log/users'),
  getEntityTypes: () => api.get('/api/activity-log/entity-types'),
};

export const reports = {
  vacancyCost: (params) => api.get('/api/reports/vacancy-cost', { params }),
  vacancyCostUnits: (params) => api.get('/api/reports/vacancy-cost/units', { params }),
  commission: (params) => api.get('/api/reports/commission', { params }),
};

export const cleaning = {
  // Cleaners (settings)
  getCleaners: () => api.get('/api/cleaning/cleaners'),
  createCleaner: (data) => api.post('/api/cleaning/cleaner', data),
  updateCleaner: (id, data) => api.put(`/api/cleaning/cleaner/${id}`, data),
  deleteCleaner: (id) => api.delete(`/api/cleaning/cleaner/${id}`),
  // Unit cleaning config
  getConfig: () => api.get('/api/cleaning/config'),
  saveConfig: (data) => api.post('/api/cleaning/config/save', data),
  // Overrides
  getOverrides: (week_of) => api.get('/api/cleaning/overrides', { params: { week_of } }),
  saveOverride: (data) => api.post('/api/cleaning/override', data),
  // Week notes (per property per week)
  getWeekNotes: (week_of) => api.get('/api/cleaning/week-notes', { params: { week_of } }),
  saveWeekNotes: (data) => api.post('/api/cleaning/week-notes', data),
  // Checkout cleaning
  getCheckout: (month) => api.get('/api/cleaning/checkout', { params: { month } }),
  updateCheckout: (id, data) => api.put(`/api/cleaning/checkout/${id}`, data),
  // Weekly schedule
  getSchedule: (week_of) => api.get('/api/cleaning/schedule', { params: { week_of } }),
  generateSchedule: (data) => api.post('/api/cleaning/schedule/generate', data),
  // Checkout notes
  getCheckoutNotes: (week_of) => api.get('/api/cleaning/checkout-notes', { params: { week_of } }),
  updateCheckoutNotes: (id, data) => api.put(`/api/cleaning/checkout-notes/${id}`, data),
};

export const utility = {
  // Groups
  getGroups: () => api.get('/api/utility/groups'),
  createGroup: (data) => api.post('/api/utility/group', data),
  updateGroup: (id, data) => api.put(`/api/utility/group/${id}`, data),
  deleteGroup: (id) => api.delete(`/api/utility/group/${id}`),
  getPropertiesUnits: () => api.get('/api/utility/properties-units'),
  getUnitGroups: () => api.get('/api/utility/unit-groups'),
  assignUnitGroups: (data) => api.post('/api/utility/unit-groups/assign', data),
  // Meters
  getMeters: (params) => api.get('/api/utility/meters', { params }),
  createMeter: (data) => api.post('/api/utility/meter', data),
  updateMeter: (id, data) => api.put(`/api/utility/meter/${id}`, data),
  deleteMeter: (id) => api.delete(`/api/utility/meter/${id}`),
  // Meter readings
  logMeterReading: (data) => api.post('/api/utility/meter-reading', data),
  getMeterReadings: (params) => api.get('/api/utility/meter-readings', { params }),
  getUnitReadings: (params) => api.get('/api/utility/unit-readings', { params }),
  // Lookup the most recent reading on any unit-mapped meter before a date.
  // Used by the create-lease form to prefill check_in_meter from the previous
  // tenant's checkout. Returns { reading_value, reading_date, from_tenant_name, ... } or null.
  getLastMeterReading: (unitId, beforeDate) =>
    api.get('/api/utility/last-meter-reading', { params: { unit_id: unitId, before_date: beforeDate } }),
  // Bills
  getLastBillDate: (params) => api.get('/api/utility/last-bill-date', { params }),
  getBills: (params) => api.get('/api/utility/bills', { params }),
  getBill: (id) => api.get(`/api/utility/bill/${id}`),
  createBill: (data) => api.post('/api/utility/bill', data),
  updateBill: (id, data) => api.put(`/api/utility/bill/${id}`, data),
  deleteBill: (id) => api.delete(`/api/utility/bill/${id}`),
  updateBillLine: (id, data) => api.put(`/api/utility/bill-line/${id}`, data),
  finalizeBill: (id) => api.post(`/api/utility/bill/${id}/finalize`),
  generateInvoices: (id, data) => api.post(`/api/utility/bill/${id}/generate-invoices`, data || {}),
  getReport: () => api.get('/api/utility/report'),
  getHighestRate: (params) => api.get('/api/utility/highest-rate', { params }),
  getCheckoutMeters: () => api.get('/api/utility/checkout-meters'),
  checkoutSettlement: (data) => api.post('/api/utility/checkout-settlement', data),
  updateSettlement: (id, data) => api.put(`/api/utility/checkout-settlement/${id}`, data),
  deleteSettlement: (id) => api.delete(`/api/utility/checkout-settlement/${id}`),
  getTenantHistory: (tenantId) => api.get(`/api/utility/tenant/${tenantId}/history`),
};

export const bookingPlatform = {
  list: () => api.get('/api/booking-platform'),
  create: (data) => api.post('/api/booking-platform', data),
  update: (id, data) => api.put(`/api/booking-platform/${id}`, data),
  delete: (id) => api.delete(`/api/booking-platform/${id}`),
};

export const chatApi = {
  // Chat (staff-test and eventually widget)
  sendMessage: (data) => api.post('/api/chat/message', data),
  // Internal staff data assistant (Chat: Internal)
  internalMessage: (data) => api.post('/api/chat/internal/message', data),
  // OCR an image attachment before sending a normal text-only chat message.
  ocrImage: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/api/chat/ocr', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  // Sessions
  listSessions: (params) => api.get('/api/chat/sessions', { params }),
  getSession:   (id) => api.get(`/api/chat/sessions/${id}`),
  takeover:     (id, disabled) => api.patch(`/api/chat/sessions/${id}/takeover`, { disabled }),
  // Settings
  getSettings:  () => api.get('/api/chat/settings'),
  updateSettings: (data) => api.put('/api/chat/settings', data),
  // Rulebook (shared knowledge)
  listKnowledge:   () => api.get('/api/chat/knowledge'),
  createKnowledge: (data) => api.post('/api/chat/knowledge', data),
  bulkKnowledge:   (entries) => api.post('/api/chat/knowledge/bulk', { entries }),
  updateKnowledge: (id, data) => api.put(`/api/chat/knowledge/${id}`, data),
  deleteKnowledge: (id) => api.delete(`/api/chat/knowledge/${id}`),
};

export const viewingApi = {
  // Top-level overview (all units + their active link)
  overview: () => api.get('/api/viewing/overview'),
  autoGenerate: () => api.post('/api/viewing/auto-generate'),
  regenerateForUnit: (unitId) => api.post(`/api/viewing/unit/${unitId}/regenerate`),
  // Shareable links
  listLinks: (unitId) => api.get(`/api/viewing/unit/${unitId}/links`),
  createLink: (unitId, data) => api.post(`/api/viewing/unit/${unitId}/links`, data || {}),
  revokeLink: (linkId) => api.patch(`/api/viewing/link/${linkId}/revoke`),
  assignEmployee: (linkId, employee_id) => api.patch(`/api/viewing/link/${linkId}/employee`, { employee_id: employee_id || null }),
  // Bookings
  listBookings: (unitId) => api.get(`/api/viewing/unit/${unitId}/bookings`),
  listAllBookings: (params) => api.get('/api/viewing/bookings', { params }),
  getBooking: (id) => api.get(`/api/viewing/bookings/${id}`),
  cancelBooking: (id) => api.patch(`/api/viewing/bookings/${id}/cancel`),
  rescheduleBooking: (id) => api.post(`/api/viewing/bookings/${id}/reschedule`),
  createManualBooking: (data) => api.post('/api/viewing/bookings/manual', data),
};

export const advertisingApi = {
  // Advertising → Vacancy: units whose current lease is expiring within its
  // renewal-intent lead window (NR 45d / UC 30d / else 20d), soonest first.
  getVacancies: () => api.get('/api/advertising/vacancies'),

  // Advertising → Templates: reusable ad copy (with %placeholders%) per unit.
  getPlaceholders: () => api.get('/api/advertising/templates/placeholders'),
  getAssignableUnits: () => api.get('/api/advertising/templates/assignable-units'),
  listTemplates: () => api.get('/api/advertising/templates'),
  getTemplate: (id) => api.get(`/api/advertising/templates/${id}`),
  createTemplate: (data) => api.post('/api/advertising/templates', data),
  updateTemplate: (id, data) => api.put(`/api/advertising/templates/${id}`, data),
  deleteTemplate: (id) => api.delete(`/api/advertising/templates/${id}`),
  assignTemplate: (id, unit_ids) => api.post(`/api/advertising/templates/${id}/assign`, { unit_ids }),
  previewTemplate: (id, unitId) => api.get(`/api/advertising/templates/${id}/preview`, { params: { unit_id: unitId } }),

  // Advertising → Scheduler: rolling auto-20 property roster + manual urgent list.
  getScheduler: () => api.get('/api/advertising/scheduler'),
  addUrgent: (data) => api.post('/api/advertising/scheduler/urgent', data),
  updateUrgent: (id, data) => api.put(`/api/advertising/scheduler/urgent/${id}`, data),
  deleteUrgent: (id) => api.delete(`/api/advertising/scheduler/urgent/${id}`),

  // Advertising → Posting plan (consumed by the PC agent).
  getPostingPlan: (date) => api.get('/api/advertising/posting-plan', { params: date ? { date } : {} }),
  markPosted: (data) => api.post('/api/advertising/posting-plan/mark', data),

  // Advertising → org-wide settings (shared footer + photo root).
  getAdSettings: () => api.get('/api/advertising/settings'),
  updateAdSettings: (data) => api.put('/api/advertising/settings', data),

  // Advertising → Forums: Facebook groups + accounts + membership.
  listForums: () => api.get('/api/advertising/forums'),
  createForum: (data) => api.post('/api/advertising/forums', data),
  updateForum: (id, data) => api.put(`/api/advertising/forums/${id}`, data),
  deleteForum: (id) => api.delete(`/api/advertising/forums/${id}`),
  setForumMembers: (id, account_ids) => api.post(`/api/advertising/forums/${id}/members`, { account_ids }),
  listAccounts: () => api.get('/api/advertising/accounts'),
  createAccount: (data) => api.post('/api/advertising/accounts', data),
  updateAccount: (id, data) => api.put(`/api/advertising/accounts/${id}`, data),
  deleteAccount: (id) => api.delete(`/api/advertising/accounts/${id}`),
};

export const salesAgent = {
  list: () => api.get('/api/sales-agent'),
  create: (data) => api.post('/api/sales-agent', data),
  update: (id, data) => api.put(`/api/sales-agent/${id}`, data),
  delete: (id) => api.delete(`/api/sales-agent/${id}`),
};

export const storageMonitoring = {
  getUsage: () => api.get('/api/storage/usage'),
  getEmailUsage: () => api.get('/api/storage/email/usage'),
};

export const master = {
  login: (data) => api.post('/api/master/login', data),
  getProfile: () => api.get('/api/master/profile'),
  listOrganizations: () => api.get('/api/master/organizations'),
  createOrganization: (data) => api.post('/api/master/organizations', data),
  updateOrganization: (id, data) => api.put(`/api/master/organizations/${id}`, data),
  getOrgStats: (id) => api.get(`/api/master/organizations/${id}/stats`),
  // API Keys
  listApiKeys: () => api.get('/api/master/api-keys'),
  createApiKey: (data) => api.post('/api/master/api-keys', data),
  updateApiKey: (id, data) => api.put(`/api/master/api-keys/${id}`, data),
  deleteApiKey: (id) => api.delete(`/api/master/api-keys/${id}`),
};

export default api;
