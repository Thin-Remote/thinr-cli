import axios from 'axios';
import { refreshToken, getAccessToken } from './auth.js';
import { readConfig } from './config.js';
import http from 'http';
import https from 'https';

const httpAgent = new http.Agent({ keepAlive: true });
// Accept self-signed certificates when talking to local dev servers
// (localhost / 127.0.0.1). Any other host still enforces full TLS
// validation. Toggleable via THINR_INSECURE=1 for other local setups.
const httpsAgent = new https.Agent({ keepAlive: true });
const insecureAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const api = axios.create({
    // You can leave baseURL undefined initially
    timeout: 10000,
    httpAgent,
    httpsAgent,
});

export function setBaseURL(url) {
    api.defaults.baseURL = url;
}

api.interceptors.request.use(
    (request) => {
        const token = getAccessToken();
        if (token) {
            request.headers['Authorization'] = `Bearer ${token}`;
        }

        // Allow self-signed TLS against localhost / 127.0.0.1 or when the user
        // opts in explicitly. Anything else keeps default certificate validation.
        try {
            const base = request.baseURL || api.defaults.baseURL || '';
            const url = new URL(request.url || '', base || 'https://placeholder/');
            const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
            if (url.protocol === 'https:' && (isLocal || process.env.THINR_INSECURE === '1')) {
                request.httpsAgent = insecureAgent;
            }
        } catch {}

        return request;
    },
    (error) => {
        return Promise.reject(error);
    },
);

api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        // Only intervene on 401s; everything else surfaces unchanged.
        if (error.response?.status !== 401) return Promise.reject(error);

        // Don't recurse: refresh requests themselves and already-retried
        // requests must not trigger another refresh.
        if (originalRequest?._isRefresh || originalRequest?._retry) {
            return Promise.reject(error);
        }

        // Tokens issued via the username/password flow have no
        // refresh_token. Skip the refresh attempt and let the 401 reach
        // the caller — they can re-run `thinr` to re-authenticate.
        if (!readConfig().refresh_token) return Promise.reject(error);

        originalRequest._retry = true;

        try {
            const newToken = await refreshToken();
            // Patch only this request; subsequent requests pick up the new
            // token from config via the request interceptor.
            originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
            return api(originalRequest);
        } catch (refreshError) {
            return Promise.reject(refreshError);
        }
    },
);

export default api;
