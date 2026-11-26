# NativeUtils

Equicord user plugin: native helpers for other plugins, running in Discord's main process. It does nothing on its own.

| Helper | What it does |
| --- | --- |
| `copyText(text)` | Copies text with Electron's clipboard, which works while Discord isn't focused (e.g. while you're in a game). Returns `false` for empty or very long text. |
| `readText()` | Reads text from the clipboard. |

## Using it from another plugin

Don't import this plugin, so yours still builds without it. Look it up at runtime and fall back when it's missing or disabled:

```ts
import { isPluginEnabled } from "@api/PluginManager";
import { copyToClipboard } from "@utils/clipboard";

export async function copyText(text: string) {
    const nativeCopy = IS_WEB ? undefined : VencordNative.pluginHelpers.NativeUtils?.copyText;
    if (nativeCopy && isPluginEnabled("NativeUtils") && await nativeCopy(text) === true) return;
    await copyToClipboard(text);
}
```

## Install

```sh
cd src/userplugins
git clone https://github.com/bluscream-vencord-plugins/nativeUtils
```

Rebuild Equicord, enable NativeUtils and restart Discord fully (the native part only loads on startup).
