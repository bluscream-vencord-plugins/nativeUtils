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
    /** Equibop's tray item our items go above, together with its group. */
    insertBeforeLabel: "Restart",
    maxTextLength: 100_000,
    maxOwnerLength: 64,
    maxIdLength: 64,
    maxLabelLength: 100,
    maxItemsPerOwner: 20,
    /** How long `waitTrayClick` waits before answering null, so the renderer can poll again. */
    clickWaitMs: 25_000,
    itemTypes: ["normal", "checkbox", "separator"]
} as const;

type ItemType = typeof PATTERNS.itemTypes[number];

interface TrayItem {
    id: string;
    label: string;
    type: ItemType;
    checked: boolean;
    enabled: boolean;
}

const ownerItems = new Map<string, TrayItem[]>();
const waiters = new Map<string, (id: string | null) => void>();
const pendingClicks = new Map<string, string[]>();
let tray: Tray | null = null;
let baseMenu: Menu | null = null;

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

function buildMenu(base: Menu): Menu {
    const own: MenuItemConstructorOptions[] = [];
    for (const [owner, items] of ownerItems) {
        if (own.length && items.length) own.push({ type: "separator" });
        for (const item of items) {
            if (item.type === "separator") own.push({ type: "separator" });
            else own.push({
                label: item.label,
                type: item.type,
                checked: item.checked,
                enabled: item.enabled,
                click: () => emitClick(owner, item.id)
            });
        }
    }

    const original = base.items;
    if (!own.length || !isEnabled()) return base;
    const restart = original.findIndex(item => item.label === PATTERNS.insertBeforeLabel);
    const at = restart > 0 && original[restart - 1].type === "separator" ? restart - 1 : restart;
    const template: Array<MenuItem | MenuItemConstructorOptions> = at < 0
        ? [...original, { type: "separator" }, ...own]
        : [...original.slice(0, at), { type: "separator" }, ...own, ...original.slice(at)];
    return Menu.buildFromTemplate(template);
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
    if (!tray || tray.isDestroyed() || !baseMenu) return;
    originalSetContextMenu.call(tray, buildMenu(baseMenu));
}

RendererSettings.addChangeListener(`plugins.${PATTERNS.pluginName}.enabled`, refresh);

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function parseItem(value: unknown): TrayItem | null {
    if (typeof value !== "object" || value === null) return null;
    const { id, label, type, checked, enabled } = value as Record<string, unknown>;
    if (!PATTERNS.itemTypes.some(t => t === type)) return null;
    if (type === "separator") return { id: "", label: "", type: "separator", checked: false, enabled: true };
    if (!isText(id, PATTERNS.maxIdLength) || !isText(label, PATTERNS.maxLabelLength)) return null;
    return { id, label, type: type === "checkbox" ? "checkbox" : "normal", checked: checked === true, enabled: enabled !== false };
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

export function hasTray() {
    return tray !== null && !tray.isDestroyed();
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
