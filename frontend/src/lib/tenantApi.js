import axios from 'axios';
import Cookies from 'js-cookie';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const tenantApi = axios.create({ baseURL: API_URL, headers: { 'Content-Type': 'application/json' } });

tenantApi.interceptors.request.use((config) => {
  const token = Cookies.get('__s_t');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

tenantApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      Cookies.remove('__s_t');
      if (typeof window !== 'undefined') window.location.href = '/tenant-portal/login';
    }
    return Promise.reject(error);
  }
);

export const tenantPortal = {
  login: (data) => tenantApi.post('/api/tenant-portal/login', data),
  getDashboard: () => tenantApi.get('/api/tenant-portal/dashboard'),
  getLeases: () => tenantApi.get('/api/tenant-portal/leases'),
  getInvoices: (params) => tenantApi.get('/api/tenant-portal/invoices', { params }),
  getProfile: () => tenantApi.get('/api/tenant-portal/profile'),
  updateProfile: (data) => tenantApi.put('/api/tenant-portal/profile', data),
};

export default tenantApi;
