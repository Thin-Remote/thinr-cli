import axios from 'axios';
import { refreshToken, getAccessToken } from './auth.js'; // Adjust the import based on your project structure
import http from 'http';
import https from 'https';

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

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