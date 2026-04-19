import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

const SPARK_GLYPHS = '▁▂▃▄▅▆▇█';

export function Sparkline({ series, width = 20, color = theme.accent, max }) {
    const data = (series || []).filter((v) => v != null && Number.isFinite(v));
    if (data.length < 2) return <Text>{' '.repeat(width)}</Text>;
    const slice = data.slice(-width);
    const ceil = max ?? 100;
    const out = slice
        .map((v) => {
            const n = Math.max(0, Math.min(ceil, v));
            const i = Math.min(
                SPARK_GLYPHS.length - 1,
                Math.floor((n / ceil) * (SPARK_GLYPHS.length - 1)),
            );
            return SPARK_GLYPHS[i];
        })
        .join('');
    const pad = width - slice.length;
    return (
        <Text>
            {pad > 0 && ' '.repeat(pad)}
            <Text color={color}>{out}</Text>
        </Text>
    );
}

export function Bar({ value, width = 20, color, ceil = 100 }) {
    const pct = value == null ? 0 : Math.max(0, Math.min(ceil, value));
    const filled = Math.round((pct / ceil) * width);
    const empty = width - filled;
    const fillColor = color ?? colorForPct(value);
    return (
        <Text>
            <Text color={theme.fgFaint}>[</Text>
            <Text color={fillColor}>{'█'.repeat(filled)}</Text>
            <Text color={theme.fgFaint}>{'░'.repeat(empty)}</Text>
            <Text color={theme.fgFaint}>]</Text>
        </Text>
    );
}

export function colorForPct(p) {
    if (p == null) return theme.fgDim;
    if (p >= 90) return theme.red;
    if (p >= 75) return theme.amber;
    return theme.lime;
}
