import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function Panel({
    title,
    sub,
    right,
    focused = false,
    children,
    flexGrow = 1,
    flexBasis,
    width,
    height,
    paddingX = 1,
    paddingY = 0,
    flexShrink,
    minHeight,
    // Default to hiding overflow: content that doesn't fit inside the panel
    // body gets clipped rather than spilling past the border (where it would
    // overwrite whatever is below or wrap into the next panel's chrome).
    overflow = 'hidden',
}) {
    const borderColor = focused ? theme.borderFocus : theme.border;
    const titleColor = focused ? theme.accent : theme.fg;
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={borderColor}
            paddingX={paddingX}
            paddingY={paddingY}
            flexGrow={flexGrow}
            flexBasis={flexBasis}
            flexShrink={flexShrink}
            width={width}
            height={height}
            minHeight={minHeight}
        >
            {title && (
                <Box marginBottom={1} justifyContent="space-between">
                    <Box>
                        <Text color={titleColor} bold>
                            {title}
                        </Text>
                        {sub && (
                            <Text color={theme.accent}>
                                <Text color={theme.fgFaint}> · </Text>
                                {sub}
                            </Text>
                        )}
                    </Box>
                    {right && <Box>{right}</Box>}
                </Box>
            )}
            <Box flexDirection="column" flexGrow={1} overflow={overflow}>
                {children}
            </Box>
        </Box>
    );
}
