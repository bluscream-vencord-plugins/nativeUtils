/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { clipboard, IpcMainInvokeEvent, Menu, MenuItem, MenuItemConstructorOptions, Point, Tray } from "electron";

const PATTERNS = {
    /** Settings key whose `enabled` gates every tray change. */
    pluginName: "NativeUtils",
    /** Equibop's tray item that "default" items go above (with its group) and "beforeRestart" items go directly before. */
    restartLabel: "Restart",
    maxTextLength: 100_000,
    maxOwnerLength: 64,
    maxIdLength: 64,
    maxLabelLength: 100,
    maxItemsPerOwner: 20,
    /** How long `waitTrayClick` waits before answering null, so the renderer can poll again. */
    clickWaitMs: 25_000,
    itemTypes: ["normal", "checkbox", "separator"],
    /** Where an item goes: the very top, directly before Equibop's Restart, or the shared block above the Restart group. */
    positions: ["top", "beforeRestart", "default"],
    /** Entry keys: plugin items are `<owner>/<id>`, Equibop's own items `equibop/<label>`, separators `separator/<index>`. */
    equibopKeyPrefix: "equibop/",
    separatorKeyPrefix: "separator/",
    /** Tray layout limits. */
    maxLayoutNodes: 200,
    maxLayoutDepth: 3,
    maxKeyLength: 200,
    /** Equibop's native Linux tray module (StatusNotifierItem), loaded by Equibop before Equicord. */
    sniModule: /libvesktop-[^\\/]+\.node$/,
    /** Ids for our items in the native Linux menu, above Equibop's own (1 to 12). */
    sniFirstId: 1000,
    /** Ids for separators the layout adds in the native Linux menu. */
    sniFirstSeparatorId: 5000,
    /** The native Linux menu has no checkbox type, so checkbox state is shown as a label prefix. */
    sniChecked: "✓ ",
    sniUnchecked: "    "
} as const;

type ItemType = typeof PATTERNS.itemTypes[number];
type Position = typeof PATTERNS.positions[number];

interface TrayItem {
    id: string;
    label: string;
    type: ItemType;
    checked: boolean;
    enabled: boolean;
    position: Position;
}

type EntryType = ItemType | "submenu";

interface Entry<T> {
    key: string;
    label: string;
    type: EntryType;
    checked: boolean;
    source: T;
}

type LayoutNode =
    | { key: string; label?: string; }
    | { separator: true; }
    | { submenu: { label: string; children: LayoutNode[]; }; };

interface TrayLayout {
    tree: LayoutNode[];
    hidden: string[];
}

type Placed<T> =
    | { kind: "entry"; entry: Entry<T>; label: string; }
    | { kind: "separator"; }
    | { kind: "submenu"; label: string; children: Placed<T>[]; };

const ownerItems = new Map<string, TrayItem[]>();
const waiters = new Map<string, (id: string | null) => void>();
const pendingClicks = new Map<string, string[]>();
let tray: Tray | null = null;
let baseMenu: Menu | null = null;
let layout: TrayLayout | null = null;
let lastEntries: Array<Entry<unknown>> = [];

const isEnabled = () => RendererSettings.store.plugins?.[PATTERNS.pluginName]?.enabled === true;

function emitClick(owner: string, id: string) {
    const waiter = waiters.get(owner);
    if (waiter) {
        waiters.delete(owner);
        waiter(id);
        return;
    }
    const queue = pendingClicks.get(owner) ?? [];
    if (queue.length < PATTERNS.maxItemsPerOwner) queue.push(id);
    pendingClicks.set(owner, queue);
}

function separatorEntry<T>(source: T): Entry<T> {
    return { key: "", label: "", type: "separator", checked: false, source };
}

function ownEntries<T>(position: Position, make: (owner: string, item: TrayItem) => T, makeSeparator: () => T): Entry<T>[] {
    const out: Entry<T>[] = [];
    for (const [owner, items] of ownerItems) {
        const mine = items.filter(item => item.position === position);
        if (out.length && mine.length) out.push(separatorEntry(makeSeparator()));
        for (const item of mine) {
            if (item.type === "separator") out.push(separatorEntry(makeSeparator()));
            else out.push({ key: `${owner}/${item.id}`, label: item.label, type: item.type, checked: item.checked, source: make(owner, item) });
        }
    }
    return out;
}

function compose<T>(base: Entry<T>[], make: (owner: string, item: TrayItem) => T, makeSeparator: () => T): Entry<T>[] {
    const top = ownEntries("top", make, makeSeparator);
    const before = ownEntries("beforeRestart", make, makeSeparator);
    const middle = ownEntries("default", make, makeSeparator);
    const block = middle.length ? [separatorEntry(makeSeparator()), ...middle] : [];

    const restart = base.findIndex(e => e.label === PATTERNS.restartLabel);
    const groupStart = restart > 0 && base[restart - 1].type === "separator" ? restart - 1 : restart;
    let list = restart < 0
        ? [...base, ...block, ...before]
        : [...base.slice(0, groupStart), ...block, ...base.slice(groupStart, restart), ...before, ...base.slice(restart)];
    if (top.length) list = [...top, separatorEntry(makeSeparator()), ...list];
    return list.map((e, i) => e.type === "separator" ? { ...e, key: PATTERNS.separatorKeyPrefix + i } : e);
}

function tidy<T>(nodes: Placed<T>[]): Placed<T>[] {
    const out = nodes.map(n => n.kind === "submenu" ? { ...n, children: tidy(n.children) } : n)
        .filter(n => n.kind !== "submenu" || n.children.some(c => c.kind !== "separator"));
    return out.filter((n, i) => n.kind !== "separator" || (i > 0 && i < out.length - 1 && out[i - 1].kind !== "separator"));
}

function place<T>(entries: Entry<T>[]): Placed<T>[] {
    const plain = entries.map((entry): Placed<T> => entry.type === "separator" ? { kind: "separator" } : { kind: "entry", entry, label: entry.label });
    if (!layout) return tidy(plain);
    const byKey = new Map(entries.filter(e => e.type !== "separator").map(e => [e.key, e]));
    const used = new Set<string>();
    const walk = (nodes: LayoutNode[]): Placed<T>[] => nodes.flatMap((node): Placed<T>[] => {
        if ("separator" in node) return [{ kind: "separator" }];
        if ("submenu" in node) return [{ kind: "submenu", label: node.submenu.label, children: walk(node.submenu.children) }];
        const entry = byKey.get(node.key);
        if (!entry || used.has(node.key)) return [];
        used.add(node.key);
        return [{ kind: "entry", entry, label: node.label ?? entry.label }];
    });
    const out = walk(layout.tree);
    const { hidden } = layout;
    for (const entry of byKey.values())
        if (!used.has(entry.key) && !hidden.includes(entry.key)) out.push({ kind: "entry", entry, label: entry.label });
    return tidy(out);
}

function toTemplate(placed: Placed<MenuItem | MenuItemConstructorOptions>[]): Array<MenuItem | MenuItemConstructorOptions> {
    return placed.map((p): MenuItem | MenuItemConstructorOptions => {
        if (p.kind === "separator") return { type: "separator" };
        if (p.kind === "submenu") return { label: p.label, submenu: Menu.buildFromTemplate(toTemplate(p.children)) };
        const { source } = p.entry;
        if (p.label === p.entry.label) return source;
        if (!(source instanceof MenuItem)) return { ...source, label: p.label };
        return {
            label: p.label,
            type: source.type,
            checked: source.checked,
            enabled: source.enabled,
            visible: source.visible,
            sublabel: source.sublabel,
            toolTip: source.toolTip,
            submenu: source.submenu ?? undefined,
            click: (_item, window, event) => source.click(event, window)
        };
    });
}

function buildMenu(base: Menu): Menu {
    if (!isEnabled()) {
        lastEntries = [];
        return base;
    }
    const baseEntries = base.items.map((item): Entry<MenuItem | MenuItemConstructorOptions> => item.type === "separator"
        ? separatorEntry(item)
        : { key: PATTERNS.equibopKeyPrefix + item.label, label: item.label, type: item.type === "checkbox" ? "checkbox" : item.submenu ? "submenu" : "normal", checked: item.checked, source: item });
    const entries = compose<MenuItem | MenuItemConstructorOptions>(baseEntries, (owner, item) => ({
        label: item.label,
        type: item.type === "checkbox" ? "checkbox" : "normal",
        checked: item.checked,
        enabled: item.enabled,
        click: () => emitClick(owner, item.id)
    }), () => ({ type: "separator" }));
    lastEntries = entries;
    if (!ownerItems.size && !layout) return base;
    return Menu.buildFromTemplate(toTemplate(place(entries)));
}

const originalSetContextMenu = Tray.prototype.setContextMenu;
const originalPopUp = Tray.prototype.popUpContextMenu;

Tray.prototype.setContextMenu = function (this: Tray, menu: Menu | null) {
    tray = this;
    baseMenu = menu;
    return originalSetContextMenu.call(this, menu && buildMenu(menu));
};

Tray.prototype.popUpContextMenu = function (this: Tray, menu?: Menu, position?: Point) {
    tray = this;
    if (menu) baseMenu = menu;
    return originalPopUp.call(this, menu && buildMenu(menu), position);
};

function refresh() {
    refreshSni();
    if (!tray || tray.isDestroyed() || !baseMenu) return;
    originalSetContextMenu.call(tray, buildMenu(baseMenu));
}

interface SniItem {
    id: number;
    label?: string;
    type?: string;
    enabled?: boolean;
    visible?: boolean;
}

interface SniModule {
    setStatusNotifierMenu(items: SniItem[]): void;
    setStatusNotifierMenuClickCallback(callback: (id: number) => void): void;
}

const isSniModule = (value: unknown): value is SniModule =>
    typeof value === "object" && value !== null
    && typeof (value as Partial<SniModule>).setStatusNotifierMenu === "function"
    && typeof (value as Partial<SniModule>).setStatusNotifierMenuClickCallback === "function";

let sni: SniModule | null = null;
let sniBaseItems: SniItem[] | null = null;
let sniOriginalSetMenu: SniModule["setStatusNotifierMenu"] | null = null;
const sniRoutes = new Map<number, { owner: string; id: string; }>();

function sniList(placed: Placed<SniItem>[], nextSeparator: () => number): SniItem[] {
    const out: SniItem[] = [];
    for (const p of placed) {
        if (p.kind === "separator") out.push({ id: nextSeparator(), type: "separator", enabled: true, visible: true });
        else if (p.kind === "submenu") out.push(
            { id: nextSeparator(), type: "separator", enabled: true, visible: true },
            ...sniList(p.children, nextSeparator),
            { id: nextSeparator(), type: "separator", enabled: true, visible: true }
        );
        else {
            const mark = p.entry.type === "checkbox" ? (p.entry.checked ? PATTERNS.sniChecked : PATTERNS.sniUnchecked) : "";
            out.push({ ...p.entry.source, label: mark + p.label });
        }
    }
    return out.filter((item, i) => item.type !== "separator" || (i > 0 && i < out.length - 1 && out[i - 1].type !== "separator"));
}

function buildSniItems(base: SniItem[]): SniItem[] {
    sniRoutes.clear();
    if (!isEnabled()) {
        lastEntries = [];
        return base;
    }
    let next = PATTERNS.sniFirstId;
    let nextSeparator = PATTERNS.sniFirstSeparatorId;
    const separator = (): SniItem => ({ id: next++, type: "separator", enabled: true, visible: true });
    const baseEntries = base.map((item): Entry<SniItem> => item.type === "separator"
        ? separatorEntry(item)
        : { key: PATTERNS.equibopKeyPrefix + (item.label ?? item.id), label: item.label ?? "", type: "normal", checked: false, source: item });
    const entries = compose(baseEntries, (owner, item) => {
        const id = next++;
        sniRoutes.set(id, { owner, id: item.id });
        return { id, label: item.label, enabled: item.enabled, visible: true };
    }, separator);
    lastEntries = entries;
    if (!ownerItems.size && !layout) return base;
    return sniList(place(entries), () => nextSeparator++);
}

function hookSni() {
    if (process.platform !== "linux") return;
    const key = Object.keys(require.cache).find(path => PATTERNS.sniModule.test(path));
    const exports: unknown = key ? require.cache[key]?.exports : undefined;
    if (!isSniModule(exports)) return;
    sni = exports;
    const setMenu = exports.setStatusNotifierMenu.bind(exports);
    const setClick = exports.setStatusNotifierMenuClickCallback.bind(exports);
    sniOriginalSetMenu = setMenu;
    exports.setStatusNotifierMenu = (items: SniItem[]) => {
        sniBaseItems = items;
        setMenu(buildSniItems(items));
    };
    exports.setStatusNotifierMenuClickCallback = (callback: (id: number) => void) => {
        setClick((id: number) => {
            const route = sniRoutes.get(id);
            if (route) emitClick(route.owner, route.id);
            else callback(id);
        });
    };
}

function refreshSni() {
    if (!sni || !sniBaseItems || !sniOriginalSetMenu) return;
    sniOriginalSetMenu(buildSniItems(sniBaseItems));
}

hookSni();
RendererSettings.addChangeListener(`plugins.${PATTERNS.pluginName}.enabled`, refresh);

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function parseItem(value: unknown): TrayItem | null {
    if (typeof value !== "object" || value === null) return null;
    const { id, label, type, checked, enabled, position } = value as Record<string, unknown>;
    if (!PATTERNS.itemTypes.some(t => t === type)) return null;
    if (position !== undefined && !PATTERNS.positions.some(p => p === position)) return null;
    const where: Position = position === "top" ? "top" : position === "beforeRestart" ? "beforeRestart" : "default";
    if (type === "separator") return { id: "", label: "", type: "separator", checked: false, enabled: true, position: where };
    if (!isText(id, PATTERNS.maxIdLength) || !isText(label, PATTERNS.maxLabelLength)) return null;
    return { id, label, type: type === "checkbox" ? "checkbox" : "normal", checked: checked === true, enabled: enabled !== false, position: where };
}

function parseLayout(value: unknown): TrayLayout | null {
    if (typeof value !== "object" || value === null) return null;
    const { tree, hidden } = value as Record<string, unknown>;
    if (!Array.isArray(tree) || !Array.isArray(hidden) || hidden.length > PATTERNS.maxLayoutNodes) return null;
    if (!hidden.every(key => isText(key, PATTERNS.maxKeyLength))) return null;
    let budget = PATTERNS.maxLayoutNodes;
    const parseNode = (node: unknown, depth: number): LayoutNode | null => {
        if (--budget < 0 || typeof node !== "object" || node === null) return null;
        const { key, label, separator, submenu } = node as Record<string, unknown>;
        if (separator === true) return { separator: true };
        if (key !== undefined) {
            if (!isText(key, PATTERNS.maxKeyLength)) return null;
            if (label === undefined) return { key };
            return isText(label, PATTERNS.maxLabelLength) ? { key, label } : null;
        }
        if (typeof submenu !== "object" || submenu === null || depth >= PATTERNS.maxLayoutDepth) return null;
        const sub = submenu as Record<string, unknown>;
        if (!isText(sub.label, PATTERNS.maxLabelLength) || !Array.isArray(sub.children)) return null;
        const children = sub.children.map(child => parseNode(child, depth + 1));
        if (children.some(child => child === null)) return null;
        return { submenu: { label: sub.label, children: children.filter((c): c is LayoutNode => c !== null) } };
    };
    const nodes = tree.map(node => parseNode(node, 0));
    if (nodes.some(node => node === null)) return null;
    return { tree: nodes.filter((n): n is LayoutNode => n !== null), hidden: hidden.filter((k): k is string => typeof k === "string") };
}

export function copyText(_: IpcMainInvokeEvent, text: unknown) {
    if (typeof text !== "string" || !text || text.length > PATTERNS.maxTextLength) return false;
    clipboard.writeText(text);
    return true;
}

export function readText() {
    return clipboard.readText();
}

export function setTrayItems(_: IpcMainInvokeEvent, owner: unknown, items: unknown) {
    if (!isText(owner, PATTERNS.maxOwnerLength) || !Array.isArray(items) || items.length > PATTERNS.maxItemsPerOwner) return false;
    const parsed = items.map(parseItem);
    if (parsed.some(item => item === null)) return false;
    const valid = parsed.filter((item): item is TrayItem => item !== null);
    if (valid.length) ownerItems.set(owner, valid);
    else {
        ownerItems.delete(owner);
        pendingClicks.delete(owner);
        waiters.get(owner)?.(null);
        waiters.delete(owner);
    }
    refresh();
    return true;
}

export function getTrayEntries() {
    return lastEntries.map(({ key, label, type, checked }) => ({ key, label, type, checked }));
}

export function setTrayLayout(_: IpcMainInvokeEvent, value: unknown) {
    if (value === null) layout = null;
    else {
        const parsed = parseLayout(value);
        if (!parsed) return false;
        layout = parsed;
    }
    refresh();
    return true;
}

export function hasTray() {
    return (tray !== null && !tray.isDestroyed()) || sniBaseItems !== null;
}

export function waitTrayClick(_: IpcMainInvokeEvent, owner: unknown) {
    if (!isText(owner, PATTERNS.maxOwnerLength)) return Promise.resolve(null);
    const queued = pendingClicks.get(owner)?.shift();
    if (queued) return Promise.resolve(queued);
    waiters.get(owner)?.(null);
    return new Promise<string | null>(resolve => {
        const timer = setTimeout(() => {
            if (waiters.get(owner) === done) waiters.delete(owner);
            resolve(null);
        }, PATTERNS.clickWaitMs);
        const done = (id: string | null) => {
            clearTimeout(timer);
            resolve(id);
        };
        waiters.set(owner, done);
    });
}
