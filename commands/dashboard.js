// @ts-check
import { ensureConfigured } from './device/_shared.js';

export async function runDashboard() {
    ensureConfigured();
    // React's package entry switches between react.development.js and
    // react.production.js based on NODE_ENV at first load. The dev
    // build has a known leak under frequent setState (facebook/react
    // #34770) — heap grows from ~100MB to >1GB in minutes when WS
    // events drive the UI. Force production unless the user has
    // explicitly asked for the dev build (e.g. while debugging).
    // Set BEFORE the dynamic import so the bundle resolves React with
    // the correct env baked in.
    if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
    const { run } = await import('../dist/dashboard.js');
    await run();
}
