// @ts-check
import { readFile as readLocalFile, writeFile as writeLocalFile, stat as statLocal } from 'fs/promises';
import { createReadStream } from 'fs';
import { Transform } from 'node:stream';
import { basename } from 'path';
import cliProgress from 'cli-progress';
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, classifyError } from '../../lib/output.js';
import { success, hint, formatBytes, formatETA } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

/**
 * Build a single-line progress bar for a byte-counted transfer.
 * Disabled when stdout isn't a TTY or when the caller asked for JSON
 * output — in both cases the caller resorts to a simpler log line.
 */
function makeTransferBar(totalBytes) {
    // cli-progress counts characters literally when sizing the line,
    // so ANSI escape codes inside barChars / placeholders would make
    // the whole thing truncate. Keep the bar and its columns plain;
    // the theme lives on the surrounding "Uploading" / "Uploaded"
    // lines instead.
    const sizeW = 9;
    const rateW = 12;
    const etaW = 11;
    const bar = new cliProgress.SingleBar({
        // `{eta}` is reserved by cli-progress (plain seconds, no label);
        // use a different placeholder name so our "ETA 12s" string
        // actually shows up instead of being silently overridden.
        format: `  {bar} {percentage}%  {transferred}/{total_human}  {rate}  {countdown}`,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        barsize: 24,
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: false,
    });
    const startedAt = Date.now();
    bar.start(totalBytes, 0, {
        transferred: formatBytes(0).padStart(sizeW),
        total_human: formatBytes(totalBytes).padEnd(sizeW),
        rate: '—'.padStart(rateW),
        countdown: 'ETA —'.padEnd(etaW),
    });
    const onProgress = (ev) => {
        const loaded = ev?.loaded ?? 0;
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = elapsed > 0 ? loaded / elapsed : 0;
        const remaining = Math.max(0, totalBytes - loaded);
        const etaSeconds = rate > 0 ? remaining / rate : Infinity;
        bar.update(loaded, {
            transferred: formatBytes(loaded).padStart(sizeW),
            total_human: formatBytes(totalBytes).padEnd(sizeW),
            rate:
                elapsed > 0.2
                    ? `${formatBytes(rate)}/s`.padStart(rateW)
                    : '—'.padStart(rateW),
            countdown:
                elapsed > 0.5 && Number.isFinite(etaSeconds)
                    ? `ETA ${formatETA(etaSeconds)}`.padEnd(etaW)
                    : 'ETA —'.padEnd(etaW),
        });
    };
    const finish = () => {
        const elapsed = (Date.now() - startedAt) / 1000;
        const averageRate = elapsed > 0 ? totalBytes / elapsed : 0;
        bar.update(totalBytes, {
            transferred: formatBytes(totalBytes).padStart(sizeW),
            total_human: formatBytes(totalBytes).padEnd(sizeW),
            rate:
                elapsed > 0
                    ? `${formatBytes(averageRate)}/s`.padStart(rateW)
                    : '—'.padStart(rateW),
            countdown: 'done'.padEnd(etaW),
        });
        bar.stop();
        return { elapsed, averageRate };
    };
    return { onProgress, finish };
}

/**
 * Split `push` and `pull` into two plain commands instead of the
 * scp-style single `cp` with `<deviceId>:` prefixes. Intent is obvious
 * from the verb and the argument order is always the same: device id,
 * then source, then destination — no ambiguity about "which side is
 * local".
 */
export function registerTransferCommands(device) {
    device
        .command('push <deviceId> <localPath> <remotePath>')
        .helpGroup('Filesystem:')
        .description('Upload a local file to the device (use trailing "/" on remote to keep the source basename)')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, localPath, remotePath, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            const finalRemote = remotePath.endsWith('/')
                ? remotePath + basename(localPath)
                : remotePath;

            try {
                const api = createDeviceAPI(deviceId, { user });
                const fileStat = await statLocal(localPath);
                const totalBytes = fileStat.size;
                const useBar = !isJsonMode() && !!process.stdout.isTTY;
                if (!useBar) {
                    // No progress bar needed — keep the simpler,
                    // whole-buffer path that other callers also use.
                    const content = await readLocalFile(localPath);
                    await api.writeFile(finalRemote, content);
                    if (isJsonMode()) {
                        printOk({
                            direction: 'push',
                            device: deviceId,
                            local: localPath,
                            remote: finalRemote,
                            bytes: content.byteLength,
                        });
                    } else {
                        console.log(
                            success(`Uploaded ${localPath} → ${deviceId}:${finalRemote}`) +
                                ' ' +
                                hint(`(${formatBytes(content.byteLength)})`),
                        );
                    }
                    return;
                }
                console.log(
                    hint(`Uploading ${localPath} → ${deviceId}:${finalRemote}`),
                );
                const { onProgress, finish } = makeTransferBar(totalBytes);
                // A Transform between the file stream and axios counts
                // bytes only when the downstream (axios → HTTP socket)
                // accepts them. Backpressure means the count rises at
                // the speed of the slowest link, so the bar tracks
                // actual network progress instead of the speed of the
                // local disk read. axios' own onUploadProgress would
                // otherwise report the buffer fill, not the wire.
                const stream = createReadStream(localPath, { highWaterMark: 64 * 1024 });
                let loaded = 0;
                const meter = new Transform({
                    transform(chunk, _enc, cb) {
                        loaded += chunk.length;
                        onProgress({ loaded, total: totalBytes });
                        cb(null, chunk);
                    },
                });
                stream.pipe(meter);
                await api.writeFile(finalRemote, meter, true, {
                    contentLength: totalBytes,
                });
                const { elapsed, averageRate } = finish();
                console.log(
                    success(`Uploaded ${localPath} → ${deviceId}:${finalRemote}`) +
                        ' ' +
                        hint(
                            `(${formatBytes(totalBytes)} in ${elapsed.toFixed(1)}s, ${formatBytes(averageRate)}/s avg)`,
                        ),
                );
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });

    device
        .command('pull <deviceId> <remotePath> <localPath>')
        .helpGroup('Filesystem:')
        .description('Download a remote file from the device to local disk')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, remotePath, localPath, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            const finalLocal = localPath.endsWith('/')
                ? localPath + basename(remotePath)
                : localPath;

            try {
                const api = createDeviceAPI(deviceId, { user });
                const useBar = !isJsonMode() && !!process.stdout.isTTY;
                if (!useBar) {
                    const buf = await api.readFile(remotePath);
                    await writeLocalFile(finalLocal, buf);
                    if (isJsonMode()) {
                        printOk({
                            direction: 'pull',
                            device: deviceId,
                            remote: remotePath,
                            local: finalLocal,
                            bytes: buf.byteLength,
                        });
                    } else {
                        console.log(
                            success(`Downloaded ${deviceId}:${remotePath} → ${finalLocal}`) +
                                ' ' +
                                hint(`(${formatBytes(buf.byteLength)})`),
                        );
                    }
                    return;
                }
                // First HEAD-like round-trip isn't available; axios
                // surfaces `total` on the first onDownloadProgress
                // frame if the server sent Content-Length. Start the
                // bar deferred until we know the total.
                console.log(
                    hint(`Downloading ${deviceId}:${remotePath} → ${finalLocal}`),
                );
                /** @type {ReturnType<typeof makeTransferBar> | null} */
                let bar = null;
                const buf = await api.readFile(remotePath, {
                    onProgress: (ev) => {
                        if (!bar && ev?.total) bar = makeTransferBar(ev.total);
                        bar?.onProgress(ev);
                    },
                });
                if (!bar) bar = makeTransferBar(buf.byteLength);
                const { elapsed, averageRate } = bar.finish();
                await writeLocalFile(finalLocal, buf);
                console.log(
                    success(`Downloaded ${deviceId}:${remotePath} → ${finalLocal}`) +
                        ' ' +
                        hint(
                            `(${formatBytes(buf.byteLength)} in ${elapsed.toFixed(1)}s, ${formatBytes(averageRate)}/s avg)`,
                        ),
                );
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}
