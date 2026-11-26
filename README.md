# NativeUtils

Equicord user plugin: native helpers for other plugins, running in Discord's main process. It does nothing on its own.

For tray menu items you can use right away, see [BetterTrayMenu](https://github.com/bluscream-vencord-plugins/betterTrayMenu), which uses this plugin.

## Helpers

| Helper | What it does |
| --- | --- |
| `copyText(text)` | Copies text with Electron's clipboard, which works while Discord isn't focused (e.g. while you're in a game). Returns `false` for empty or very long text. |
| `readText()` | Reads text from the clipboard. |
| `setTrayItems(owner, items)` | Sets your plugin's items in Equibop's tray menu, shown above Restart and Quit (up to 20). Each item is `{ id, label, type: "normal" \| "checkbox" \| "separator", checked?, enabled? }`. An empty list removes them. |
| `waitTrayClick(owner)` | Resolves with the id of the next clicked item of yours, or `null` after about 25 seconds. Call it in a loop. Clicks between two calls are queued. |
| `hasTray()` | Whether a tray exists to add items to. |

Tray items only appear while NativeUtils is enabled.

How the tray works: Equicord loads plugin native code before Equibop builds its tray, so NativeUtils wraps Electron's `Tray.setContextMenu` and adds the registered items whenever Equibop sets the menu. Nothing on disk is changed. If an Equibop update builds its tray differently, the extra items simply stop appearing and Equibop's own menu keeps working.

On Linux, Equibop uses its own native tray module (`libvesktop-<arch>.node`, a StatusNotifierItem) instead of Electron's tray. Equibop loads it before Equicord, so NativeUtils finds it in Node's module cache and wraps its `setStatusNotifierMenu` and `setStatusNotifierMenuClickCallback` the same way. That menu has no checkbox type, so checkbox items show a ✓ in front of the label instead. **The Linux part is untested**: it was written against Equibop's code but never run on Linux. If it doesn't work there, Equibop's own tray keeps working.

## Using it from another plugin

Don't import this plugin, so yours still builds without it. Look it up at runtime and fall back when it's missing or disabled:

```ts
import { isPluginEnabled } from "@api/PluginManager";
import { copyToClipboard } from "@utils/clipboard";
import { sleep } from "@utils/misc";

function nativeUtils() {
    if (IS_WEB || !isPluginEnabled("NativeUtils")) return undefined;
    return VencordNative.pluginHelpers.NativeUtils;
}

export async function copyText(text: string) {
    if (await nativeUtils()?.copyText(text) === true) return;
    await copyToClipboard(text);
}

// Tray item: register, then wait for clicks while your plugin runs.
// Check for NativeUtils on every round and sleep when it's missing or a call fails,
// otherwise the loop would spin without waiting and freeze Discord.
async function trayLoop() {
    while (running) {
        const native = nativeUtils();
        if (!native) {
            await sleep(5000);
            continue;
        }
        try {
            await native.setTrayItems("MyPlugin", [{ id: "hello", label: "Say hello", type: "normal" }]);
            const id = await native.waitTrayClick("MyPlugin");
            if (running && id === "hello") doSomething();
        } catch {
            await sleep(5000);
        }
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
