import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useInput } from 'ink';

// Single source of truth for "what is focused" and "what overlays own input".
//
// Two primitives:
//   useFocusable({ id, parent, handlers, hint, when }) — registers an
//     interactive area. `parent` groups focusables (e.g. all panels of the
//     overview tab); only one focusable per group is focused at a time.
//   useModal(handler, { when, hint }) — pushes onto a modal stack. While
//     anything is on the stack, no useFocusable handlers run; the topmost
//     modal owns input and its hints surface in the footer.
//
// `useTabCycle(parent)` mounts once near the group root and handles
// tab/shift-tab. `useFocusHints(parent)` exposes the currently active hints
// to the footer — no static hint table to maintain alongside handlers.
//
// Internally we split the context in two so that:
//   - DispatchCtx holds stable callbacks (register, focus, cycle, ...).
//     Components depending only on these (effects that register/unregister)
//     don't re-run when focus changes.
//   - SignalCtx exposes a tick that flips on every focus change. Components
//     reading focus state (selectors) subscribe to this ctx and re-render
//     when the tick advances.

const DispatchCtx = createContext(null);
const SignalCtx = createContext(0);

function useDispatch() {
    const d = useContext(DispatchCtx);
    if (!d) throw new Error('FocusProvider missing — wrap the dashboard tree.');
    return d;
}

export function FocusProvider({ children }) {
    const focusablesRef = useRef(new Map()); // id → { id, parent, handlersRef, hintRef, order }
    const focusedRef = useRef(new Map()); // parent → id
    const modalsRef = useRef([]); // [{ handlerRef, hintRef }]
    const orderRef = useRef(0);
    const [tick, setTick] = useState(0);
    const rerender = useCallback(() => setTick((t) => t + 1), []);

    // Dispatch is stable — referencing only `rerender` which is itself
    // stable. Effects that depend on dispatch don't re-run on focus
    // changes; only on provider mount.
    const dispatch = useMemo(() => {
        const register = (entry) => {
            focusablesRef.current.set(entry.id, {
                ...entry,
                order: orderRef.current++,
            });
            if (!focusedRef.current.has(entry.parent)) {
                focusedRef.current.set(entry.parent, entry.id);
            }
            rerender();
            return () => {
                focusablesRef.current.delete(entry.id);
                if (focusedRef.current.get(entry.parent) === entry.id) {
                    const sibling = [...focusablesRef.current.values()].find(
                        (e) => e.parent === entry.parent,
                    );
                    if (sibling) focusedRef.current.set(entry.parent, sibling.id);
                    else focusedRef.current.delete(entry.parent);
                }
                rerender();
            };
        };

        const focus = (id) => {
            const entry = focusablesRef.current.get(id);
            if (!entry) return;
            focusedRef.current.set(entry.parent, id);
            rerender();
        };

        const cycle = (direction, parent) => {
            const siblings = [...focusablesRef.current.values()]
                .filter((e) => e.parent === parent)
                .sort((a, b) => a.order - b.order);
            if (siblings.length === 0) return;
            const curId = focusedRef.current.get(parent);
            const i = siblings.findIndex((e) => e.id === curId);
            const delta = direction === 'prev' ? -1 : 1;
            const next = siblings[(i + delta + siblings.length) % siblings.length];
            focusedRef.current.set(parent, next.id);
            rerender();
        };

        const pushModal = (entry) => {
            modalsRef.current.push(entry);
            rerender();
            return () => {
                modalsRef.current = modalsRef.current.filter((m) => m !== entry);
                rerender();
            };
        };

        // Selectors read from refs. They're cheap and don't allocate.
        const isFocused = (id) => {
            const entry = focusablesRef.current.get(id);
            if (!entry) return false;
            if (modalsRef.current.length > 0) return false;
            return focusedRef.current.get(entry.parent) === id;
        };
        const topModal = () =>
            modalsRef.current.length > 0
                ? modalsRef.current[modalsRef.current.length - 1]
                : null;
        const isModalActive = () => modalsRef.current.length > 0;
        const focusedHintFor = (parent) => {
            const id = focusedRef.current.get(parent);
            if (!id) return null;
            const entry = focusablesRef.current.get(id);
            return entry?.hintRef?.current ?? null;
        };

        return {
            register,
            focus,
            cycle,
            pushModal,
            isFocused,
            topModal,
            isModalActive,
            focusedHintFor,
        };
    }, [rerender]);

    return React.createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        React.createElement(SignalCtx.Provider, { value: tick }, children),
    );
}

/**
 * Register an interactive area.
 *
 * Hints are read through a ref so callers can pass dynamic arrays without
 * forcing the registry to re-add the entry on every render.
 */
export function useFocusable({ id, parent, handlers, hint, when = true }) {
    const dispatch = useDispatch();
    // Subscribe to focus changes: re-render when the signal advances.
    useContext(SignalCtx);

    const handlersRef = useRef(handlers);
    const hintRef = useRef(hint);
    handlersRef.current = handlers;
    hintRef.current = hint;

    useEffect(() => {
        if (!when) return undefined;
        return dispatch.register({ id, parent, handlersRef, hintRef });
    }, [dispatch, id, parent, when]);

    const focused = dispatch.isFocused(id);

    useInput(
        (input, key) => {
            const fn = handlersRef.current;
            if (typeof fn === 'function') fn(input, key);
        },
        { isActive: when && focused },
    );

    const focusSelf = useCallback(() => dispatch.focus(id), [dispatch, id]);
    return { focused, focus: focusSelf };
}

/**
 * Push a modal onto the input stack. While topmost, this handler owns input
 * and all useFocusable siblings stop receiving keys.
 */
export function useModal(handler, { when = true, hint } = {}) {
    const dispatch = useDispatch();
    useContext(SignalCtx); // re-render when stack changes

    const handlerRef = useRef(handler);
    const hintRef = useRef(hint);
    const entryRef = useRef(null);
    handlerRef.current = handler;
    hintRef.current = hint;

    useEffect(() => {
        if (!when) return undefined;
        const entry = { handlerRef, hintRef };
        entryRef.current = entry;
        return dispatch.pushModal(entry);
    }, [dispatch, when]);

    const isTop = dispatch.topModal() === entryRef.current;
    useInput(
        (input, key) => {
            const fn = handlerRef.current;
            if (typeof fn === 'function') fn(input, key);
        },
        { isActive: when && isTop },
    );
}

/**
 * Tab/shift-tab cycle within a parent group.
 */
export function useTabCycle(parent, { when = true } = {}) {
    const dispatch = useDispatch();
    useContext(SignalCtx);
    const isModal = dispatch.isModalActive();
    useInput(
        (_input, key) => {
            if (!key.tab) return;
            dispatch.cycle(key.shift ? 'prev' : 'next', parent);
        },
        { isActive: when && !isModal },
    );
}

/**
 * Footer hints for the currently focused focusable in `parent`. Falls back
 * to the topmost modal's hint when an overlay owns input.
 */
export function useFocusHints(parent) {
    const dispatch = useDispatch();
    useContext(SignalCtx);
    const top = dispatch.topModal();
    if (top?.hintRef?.current) return top.hintRef.current;
    return dispatch.focusedHintFor(parent) || [];
}

/**
 * Global keys that always work when no modal is active.
 */
export function useGlobalKeys(handler, { when = true } = {}) {
    const dispatch = useDispatch();
    useContext(SignalCtx);
    const isModal = dispatch.isModalActive();
    const ref = useRef(handler);
    ref.current = handler;
    useInput(
        (input, key) => {
            const fn = ref.current;
            if (typeof fn === 'function') fn(input, key);
        },
        { isActive: when && !isModal },
    );
}
