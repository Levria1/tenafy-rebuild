import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// `withCredentials` and nothing else. The session cookie (__t_p) is httpOnly, so this
// file cannot read it and does not try: the browser attaches it automatically. The old
// client pulled a token out of a JS-readable cookie and set an Authorization header,
// which meant any XSS on a tenant page could walk off with a working session.
const tenantApi = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

tenantApi.interceptors.response.use(
  (response) => response,
  (error) => {
    // 401 means the session is gone or was never there. 403 means the account is real
    // but disabled, or its tenant records were removed; both need a fresh sign-in, and
    // neither should be handled by the page that happened to make the call.
    const status = error.response?.status;
    if ((status === 401 || status === 403) && typeof window !== 'undefined') {
      const onAuthPage = ['/tenant-portal/login', '/tenant-portal/register', '/tenant-portal/set-password']
        .some((p) => window.location.pathname.startsWith(p));
      if (!onAuthPage) window.location.href = '/tenant-portal/login';
    }
    return Promise.reject(error);
  }
);

export const tenantPortal = {
  register: (data) => tenantApi.post('/api/tenant-portal/register', data),
  completeRegistration: (data) => tenantApi.post('/api/tenant-portal/register/complete', data),
  login: (data) => tenantApi.post('/api/tenant-portal/login', data),
  logout: () => tenantApi.post('/api/tenant-portal/logout'),

  getDashboard: () => tenantApi.get('/api/tenant-portal/dashboard'),
  getLeases: () => tenantApi.get('/api/tenant-portal/leases'),
  getInvoices: (params) => tenantApi.get('/api/tenant-portal/invoices', { params }),
  getProfile: () => tenantApi.get('/api/tenant-portal/profile'),
  updateProfile: (data) => tenantApi.put('/api/tenant-portal/profile', data),

  getUtilities: () => tenantApi.get('/api/tenant-portal/utilities'),

  // Payment activity on one invoice, loaded when its row is expanded rather than for
  // every row up front. Each entry carries receipt_available, decided by the same
  // renderer that would produce the file.
  getInvoicePayments: (id) => tenantApi.get(`/api/tenant-portal/invoices/${id}/payments`),

  // Blobs, not URLs. Both are Content-Disposition: attachment, and going through axios
  // keeps the 401 interceptor in play — a window.open on an expired session would
  // otherwise download a JSON error body named invoice-TRIV1234.pdf.
  downloadInvoicePdf: (id) =>
    tenantApi.get(`/api/tenant-portal/invoices/${id}/pdf`, { responseType: 'blob' }),
  downloadReceiptPdf: (paymentId) =>
    tenantApi.get(`/api/tenant-portal/payments/${paymentId}/receipt`, { responseType: 'blob' }),

  getRepairs: () => tenantApi.get('/api/tenant-portal/service'),
  getRepairOptions: () => tenantApi.get('/api/tenant-portal/service/options'),
  // Multipart: photos ride along with the form so there is no orphan-file-id to validate.
  createRepair: (formData) => tenantApi.post('/api/tenant-portal/service', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),

  // Append, never replace. There is no update or delete here on purpose: rewriting a
  // description a vendor has already been booked against sends them to the wrong job.
  addRepairNote: (id, note) => tenantApi.post(`/api/tenant-portal/service/${id}/note`, { note }),
  cancelRepair: (id, reason) => tenantApi.post(`/api/tenant-portal/service/${id}/cancel`, { reason }),

  // A URL rather than a fetch: it goes straight into an <img src>, and the browser
  // attaches the session cookie itself because the API and the portal are the same
  // origin in production. Repair photos are stored is_private, so this dedicated route
  // is the only way to see them; /api/file/preview refuses them, which is the point.
  repairPhotoUrl: (serviceId, fileId) =>
    `${API_URL}/api/tenant-portal/service/${serviceId}/photo/${fileId}`,
};

export default tenantApi;
