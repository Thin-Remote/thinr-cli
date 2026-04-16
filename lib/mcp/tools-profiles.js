// @ts-check
import { listProfiles, getActiveProfile, getProfile } from '../config.js';

async function toolProfiles() {
    const names = listProfiles();
    const active = getActiveProfile();
    const lines = names.map((n) => {
        const data = getProfile(n) || {};
        const marker = n === active ? '* ' : '  ';
        return `${marker}${n}  (${data.username || ''}@${data.server || n})`;
    });
    return {
        content: [{ type: 'text', text: lines.join('\n') || 'No profiles configured' }],
        isError: false,
    };
}

export const tools = [
    {
        name: 'thinr_profiles',
        description:
            'List configured CLI profiles (each profile targets a different ThinRemote server). Use the returned profile name as the optional `profile` parameter on any other tool to target that environment for a single call.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
        handler: toolProfiles,
    },
];
