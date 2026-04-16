import axios from 'axios';
import { refreshToken, getAccessToken } from './auth.js'; // Adjust the import based on your project structure
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

api.interceptors.request.use(request => {

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
    } catch (_) {}

    return request;
}, error => {
    return Promise.reject(error);
});

api.interceptors.response.use(
    response => response,
    async error => {
        const originalRequest = error.config;

        // Only handle 401 once
        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;

            try {
                const newToken = await refreshToken();

                // Set new token on headers
                api.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
                originalRequest.headers['Authorization'] = `Bearer ${newToken}`;

                // return the retried request
                return api(originalRequest);
            } catch (refreshError) {
                // Token refresh failed, reject to trigger outer catch
                return Promise.reject(refreshError);
            }
        }

        // Any other errors
        return Promise.reject(error);
    }
);

export default api;