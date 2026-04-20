import axios from 'axios';

// Dedicated axios instance for the public (no-auth) viewing-booking surface.
// Intentionally does NOT attach the __s_t cookie and does NOT redirect on 401
// — the public pages must work for visitors who have never logged in.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const bookingApi = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: false,
});

export const viewingPublic = {
  getLink: (token) => bookingApi.get(`/api/viewing-public/link/${token}`),
  getAvailability: (token, params) => bookingApi.get(`/api/viewing-public/link/${token}/availability`, { params }),
  submitBooking: (token, data) => bookingApi.post(`/api/viewing-public/link/${token}/bookings`, data),
  getAction: (token) => bookingApi.get(`/api/viewing-public/action/${token}`),
  decide: (token, decision) => bookingApi.post(`/api/viewing-public/action/${token}`, { decision }),
  getManage: (token) => bookingApi.get(`/api/viewing-public/manage/${token}`),
  cancel: (token) => bookingApi.post(`/api/viewing-public/manage/${token}/cancel`),
};

export default bookingApi;
