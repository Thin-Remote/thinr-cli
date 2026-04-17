import React from 'react';
import { render } from 'ink';
import { App } from './App.jsx';
import { readConfig } from '../../lib/config.js';
import { connectToDeviceConsole } from '../../lib/console.js';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// Clear screen + scrollback + home: starts the console session on an
// empty canvas so banners from previous sessions don't pile up.
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

export async function run() {
    const config = readConfig();
    const server = config?.server || null;

    let altScreenActive = false;
    const enterAlt = () => {
        if (altScreenActive) return;
        process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
        altScreenActive = true;
    };
    const leaveAlt = () => {
        if (!altScreenActive) return;
        process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
        altScreenActive = false;
    };

    // Belt and braces: restore on every way the process can exit, so the
    // user never ends up with a blank terminal if something goes sideways.
    const onExit = () => leaveAlt();
    process.on('exit', onExit);
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
    process.on('uncaughtException', onExit);

    try {
        while (true) {
            let action = null;
            enterAlt();
            const instance = render(
                <App server={server} onAction={(a) => (action = a)} />,
                { exitOnCtrlC: true },
            );
            await instance.waitUntilExit();

            if (action?.type === 'console') {
                leaveAlt();
                process.stdout.write(CLEAR_SCREEN);
                try {
                    await connectToDeviceConsole(action.deviceId);
                } catch (err) {
                    process.stderr.write(`\nConsole error: ${err.message || err}\n`);
                    await new Promise((r) => setTimeout(r, 1500));
                }
                process.stdout.write(CLEAR_SCREEN);
                continue;
            }
            break;
        }
    } finally {
        leaveAlt();
        process.off('exit', onExit);
        process.off('SIGINT', onExit);
        process.off('SIGTERM', onExit);
        process.off('uncaughtException', onExit);
    }
}
