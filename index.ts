/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled, plugins, pluginRequiresRestart, startPlugin, stopPlugin } from "@api/PluginManager";
import { definePluginSettings, Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelActions, ChannelStore, MediaEngineStore, NavigationRouter, SelectedChannelStore, showToast, VoiceActions } from "@webpack/common";

const logger = new Logger("NativeUtils");

const PATTERNS = {
    owner: "NativeUtils",
    ids: {
        mute: "mute",
        deafen: "deafen",
        channel: "voice-channel",
        disconnect: "disconnect",
        pluginPrefix: "plugin:"
    },
    dmGuild: "@me",
    listSeparator: ",",
    retryDelayMs: 5000
};

const Native = IS_WEB ? undefined : VencordNative.pluginHelpers.NativeUtils as PluginNative<typeof import("./native")> | undefined;

const settings = definePluginSettings({
    trayMute: { type: OptionType.BOOLEAN, description: "Show a Mute toggle in the tray menu.", default: true, onChange: () => updateTray() },
    trayDeafen: { type: OptionType.BOOLEAN, description: "Show a Deafen toggle in the tray menu.", default: true, onChange: () => updateTray() },
    trayVoiceChannel: { type: OptionType.BOOLEAN, description: "Show your current voice channel in the tray menu. Clicking it opens the channel.", default: true, onChange: () => updateTray() },
    trayDisconnect: { type: OptionType.BOOLEAN, description: "Show Disconnect in the tray menu while you're in voice.", default: true, onChange: () => updateTray() },
    trayPlugins: { type: OptionType.STRING, description: "Comma separated plugin names to toggle from the tray menu.", default: "", onChange: () => updateTray() }
});

interface TrayItem {
    id: string;
    label: string;
    type: "normal" | "checkbox" | "separator";
    checked?: boolean;
    enabled?: boolean;
}

let running = false;
let lastItems = "";

function trayPluginNames() {
    return settings.store.trayPlugins.split(PATTERNS.listSeparator).map(name => name.trim()).filter(name => name in plugins);
}

function voiceChannel() {
    const id = SelectedChannelStore.getVoiceChannelId();
    return id ? ChannelStore.getChannel(id) : undefined;
}

function buildItems(): TrayItem[] {
    const { trayMute, trayDeafen, trayVoiceChannel, trayDisconnect } = settings.store;
    const items: TrayItem[] = [];
    if (trayMute) items.push({ id: PATTERNS.ids.mute, label: "Mute", type: "checkbox", checked: MediaEngineStore.isSelfMute() });
    if (trayDeafen) items.push({ id: PATTERNS.ids.deafen, label: "Deafen", type: "checkbox", checked: MediaEngineStore.isSelfDeaf() });

    const channel = voiceChannel();
    if (channel && trayVoiceChannel) items.push({ id: PATTERNS.ids.channel, label: `In voice: ${channel.name || "Call"}`.slice(0, 100), type: "normal" });
    if (channel && trayDisconnect) items.push({ id: PATTERNS.ids.disconnect, label: "Disconnect", type: "normal" });

    const names = trayPluginNames();
    if (names.length && items.length) items.push({ id: "", label: "", type: "separator" });
    for (const name of names.slice(0, 10)) {
        const restart = pluginRequiresRestart(plugins[name]) ? " (restart)" : "";
        items.push({ id: PATTERNS.ids.pluginPrefix + name, label: `${name}${restart}`.slice(0, 100), type: "checkbox", checked: isPluginEnabled(name) });
    }
    return items;
}

function updateTray() {
    if (!running || !Native) return;
    const items = buildItems();
    const key = JSON.stringify(items);
    if (key === lastItems) return;
    lastItems = key;
    Native.setTrayItems(PATTERNS.owner, items).catch(e => logger.warn("Updating the tray failed", e));
}

function togglePlugin(name: string) {
    const plugin = plugins[name];
    const enabled = !isPluginEnabled(name);
    Settings.plugins[name].enabled = enabled;
    if (pluginRequiresRestart(plugin)) {
        showToast({ text: `${name} ${enabled ? "enabled" : "disabled"}. Restart Discord to apply.` });
        return;
    }
    const ok = enabled ? startPlugin(plugin) : stopPlugin(plugin);
    if (!ok) showToast({ text: `Couldn't ${enabled ? "start" : "stop"} ${name}.`, variant: "critical" });
}

function onClick(id: string) {
    switch (id) {
        case PATTERNS.ids.mute: return VoiceActions.toggleSelfMute();
        case PATTERNS.ids.deafen: return VoiceActions.toggleSelfDeaf();
        case PATTERNS.ids.disconnect: return ChannelActions.disconnect();
        case PATTERNS.ids.channel: {
            const channel = voiceChannel();
            if (!channel) return;
            VesktopNative?.win?.focus?.();
            return NavigationRouter.transitionTo(`/channels/${channel.guild_id ?? PATTERNS.dmGuild}/${channel.id}`);
        }
    }
    if (id.startsWith(PATTERNS.ids.pluginPrefix)) togglePlugin(id.slice(PATTERNS.ids.pluginPrefix.length));
}

async function clickLoop() {
    while (running && Native) {
        try {
            const id = await Native.waitTrayClick(PATTERNS.owner);
            if (running && id) onClick(id);
        } catch (e) {
            logger.warn("Waiting for tray clicks failed", e);
            await sleep(PATTERNS.retryDelayMs);
        }
        updateTray();
    }
}

export default definePlugin({
    name: "NativeUtils",
    description: "Gives other plugins native helpers, like copying to the clipboard while Discord isn't focused, and adds voice controls and plugin toggles to the tray menu.",
    authors: [
        { name: "Bluscream", id: 467777925790564352n },
        { name: "Claude Opus 5.5", id: 0n }
    ],
    settings,

    flux: {
        AUDIO_TOGGLE_SELF_MUTE: updateTray,
        AUDIO_TOGGLE_SELF_DEAF: updateTray,
        AUDIO_SET_SELF_MUTE: updateTray,
        VOICE_CHANNEL_SELECT: updateTray,
        RTC_CONNECTION_STATE: updateTray
    },

    start() {
        if (!Native) return;
        running = true;
        lastItems = "";
        updateTray();
        clickLoop();
    },

    stop() {
        running = false;
        lastItems = "";
        Native?.setTrayItems(PATTERNS.owner, []).catch(e => logger.warn("Clearing the tray failed", e));
    }
});
