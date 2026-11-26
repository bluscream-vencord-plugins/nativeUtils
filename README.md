# NativeUtils

Equicord user plugin: native helpers for other plugins, running in Discord's main process, plus voice controls and plugin toggles in Equibop's tray menu.

## Tray menu

Adds these items to Equibop's tray menu, above Restart and Quit. Each can be turned off in the settings.

| Item | What it does |
| --- | --- |
| Mute / Deafen | Checkboxes that show and toggle your mute and deafen state. |
| In voice: *channel* | Your current voice channel. Clicking it focuses Discord and opens the channel. |
| Disconnect | Leaves voice. Only shown while you're in voice. |
| Plugin toggles | One checkbox per plugin listed in the *trayPlugins* setting (comma separated names). Plugins that patch Discord's code need a restart; their label says so. |

Other plugins can add their own items (see below). Items only appear while NativeUtils is enabled.

How it works: Equicord loads plugin native code before Equibop builds its tray, so NativeUtils wraps Electron's `Tray.setContextMenu` and adds its items whenever Equibop sets the menu. Nothing on disk is changed. If an Equibop update builds its tray differently, the extra items simply stop appearing and Equibop's own menu keeps working.

## Helpers

| Helper | What it does |
| --- | --- |
| `copyText(text)` | Copies text with Electron's clipboard, which works while Discord isn't focused (e.g. while you're in a game). Returns `false` for empty or very long text. |
| `readText()` | Reads text from the clipboard. |
| `setTrayItems(owner, items)` | Sets your plugin's tray items (up to 20). Each item is `{ id, label, type: "normal" \| "checkbox" \| "separator", checked?, enabled? }`. An empty list removes them. |
| `waitTrayClick(owner)` | Resolves with the id of the next clicked item of yours, or `null` after about 25 seconds. Call it in a loop. Clicks between two calls are queued. |
| `hasTray()` | Whether a tray exists to add items to. |

## Using it from another plugin

Don't import this plugin, so yours still builds without it. Look it up at runtime and fall back when it's missing or disabled:

```ts
import { isPluginEnabled } from "@api/PluginManager";
import { copyToClipboard } from "@utils/clipboard";

function nativeUtils() {
    if (IS_WEB || !isPluginEnabled("NativeUtils")) return undefined;
    return VencordNative.pluginHelpers.NativeUtils;
}

export async function copyText(text: string) {
    if (await nativeUtils()?.copyText(text) === true) return;
    await copyToClipboard(text);
}

// Tray item: register once, then wait for clicks in a loop while your plugin runs.
async function trayLoop() {
    await nativeUtils()?.setTrayItems("MyPlugin", [{ id: "hello", label: "Say hello", type: "normal" }]);
    while (running) {
        const id = await nativeUtils()?.waitTrayClick("MyPlugin");
        if (id === "hello") doSomething();
    }
}
```

Clear your items with `setTrayItems("MyPlugin", [])` in your plugin's `stop()`.

## Install

```sh
cd src/userplugins
git clone https://github.com/bluscream-vencord-plugins/nativeUtils
```

Rebuild Equicord, enable NativeUtils and restart Discord fully (the native part only loads on startup).
