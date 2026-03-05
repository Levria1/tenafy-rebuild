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
        window.location.href = '/login';
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
  listUsers: (data, params) => api.post('/api/users', data, { params }),
  createUser: (data) => api.post('/api/user', data),
  updateUser: (id, data) => api.put(`/api/user/${id}`, data),
  deleteUser: (id) => api.delete(`/api/user/${id}`),
  getUser: (id) => api.get(`/api/user/${id}`),
};

export const property = {
  list: (data, params) => api.post('/api/property/list', data, { params }),
  getAll: () => api.get('/api/property/all'),
  getAllWithUnits: () => api.get('/api/property/all/with_units'),
  get: (id) => api.get(`/api/property/${id}`),
  getBase: (id) => api.get(`/api/property/${id}/base`),
  create: (data) => api.post('/api/property', data),
  update: (id, data) => api.put(`/api/property/${id}`, data),
  delete: (id) => api.delete(`/api/property/${id}`),
  clone: (id) => api.get(`/api/property/${id}/clone`),
  // Unit methods
  getUnits: (propertyId) => api.get(`/api/property/${propertyId}/unit`),
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
};

export const tenant = {
  list: (data, params) => api.post('/api/tenant/contacts', data, { params }),
  getAll: (params) => api.get('/api/tenant/tenants', { params }),
  get: (id) => api.get(`/api/tenant/${id}`),
  getProfile: (id) => api.get(`/api/tenant/${id}/profile`),
  getProfileSum: (id) => api.get(`/api/tenant/${id}/profile/sum`),
  create: (data) => api.post('/api/tenant', data),
  update: (id, data) => api.put(`/api/tenant/${id}/profile`, data),
  delete: (id) => api.delete(`/api/tenant/${id}`),
  getLeases: (id) => api.get(`/api/tenant/${id}/leases`),
  getLeasesSum: (id) => api.get(`/api/tenant/${id}/leases/sum`),
  getAccountingList: (id, data, params) => api.post(`/api/tenant/${id}/accounting/list`, data, { params }),
  getAccountingSum: (id, data) => api.post(`/api/tenant/${id}/accounting/sum`, data),
  getOutstanding: () => api.get('/api/tenant/outstanding'),
};

export const leasing = {
  list: (data, params) => api.post('/api/leasing/list', data, { params }),
  getExpiring: (params) => api.get('/api/leasing/list/expiring', { params }),
  get: (id) => api.get(`/api/leasing/${id}`),
  create: (data) => api.post('/api/leasing', data),
  update: (id, data) => api.put(`/api/leasing/${id}`, data),
  delete: (id) => api.delete(`/api/leasing/${id}`),
  getTenants: () => api.get('/api/leasing/tenant/list'),
  getUnitLease: (unitId) => api.get(`/api/leasing/unit/lease/${unitId}`),
  getSumAmount: (id) => api.get(`/api/leasing/sum_amount/${id}`),
  getInvoiceSchedule: () => api.get('/api/leasing/invoice/schedule'),
  getUnits: (data) => api.post('/api/leasing/unit', data),
  getAvailableUnits: (data) => api.post('/api/leasing/unit/available', data),
  checkConflict: (data) => api.post('/api/leasing/check-conflict', data),
};

export const accounting = {
  list: (data, params) => api.post('/api/accounting/accounts', data, { params }),
  getLines: (data, params) => api.post('/api/accounting/account/lines', data, { params }),
  get: (id) => api.get(`/api/accounting/account/${id}`),
  create: (data) => api.post('/api/accounting/account', data),
  update: (id, data) => api.put(`/api/accounting/account/${id}`, data),
  delete: (id) => api.delete(`/api/accounting/account/${id}`),
  getInflowOutflow: (data) => api.post('/api/accounting/account/inflow-outflow', data),
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
  update: (id, data) => api.put(`/api/invoice/${id}`, data),
  delete: (id) => api.delete(`/api/invoice/${id}`),
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
  delete: (id) => api.delete(`/api/service/delete/${id}`),
  getCategories: () => api.get('/api/service/category'),
  getVendors: () => api.get('/api/service/vendor/list'),
  getPropertyList: () => api.get('/api/service/property/list'),
  getUnitsByProperty: (propertyId) => api.get(`/api/service/property/${propertyId}/unit`),
  getUnitById: (unitId) => api.get(`/api/service/property/unit/${unitId}`),
  getInvoiceList: (id, params) => api.get('/api/service/invoice/list', { params: { id, ...params } }),
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

export const emailTemplate = {
  list: (data, params) => api.post('/api/email-template/list', data, { params }),
  getAll: (params) => api.get('/api/email-template/all', { params }),
  getTypes: () => api.get('/api/email-template/types/get'),
  getVariables: () => api.get('/api/email-template/variable/get'),
  get: (id) => api.get(`/api/email-template/${id}`),
  create: (data) => api.post('/api/email-template', data),
  update: (id, data) => api.put(`/api/email-template/${id}`, data),
  delete: (id) => api.delete(`/api/email-template/${id}`),
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
};

export const pdf = {
  // Returns URL string — open in new tab or use as href for direct streaming
  invoiceUrl: (id) => `${API_URL}/api/pdf/invoice/${id}`,
  leaseUrl: (id) => `${API_URL}/api/pdf/lease/${id}`,
  // Fetch as blob (for download with custom filename)
  fetchInvoice: (id) => api.get(`/api/pdf/invoice/${id}`, { responseType: 'blob' }),
  fetchLease: (id) => api.get(`/api/pdf/lease/${id}`, { responseType: 'blob' }),
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

export const storageMonitoring = {
  getUsage: () => api.get('/api/storage/usage'),
  getEmailUsage: () => api.get('/api/storage/email/usage'),
};

export default api;
