# Claude Auto-Continue — Community Build

This is an unofficial community build based on the original Claude Auto-Continue v1.3.0. Its version is 1.3.1; it is not an official release from the original author. It automatically clicks enabled Retry or Continue controls on `claude.ai` and cannot bypass Claude's server-side usage limits.

## Install in Chrome

1. Download or extract this folder to a location that will not be moved.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Open or refresh `https://claude.ai` and make sure the extension is enabled.

After changing the extension files, click **Reload** on its card in `chrome://extensions`, then refresh open Claude tabs. If you disable or remove the extension, also refresh open Claude tabs so any already-injected content scripts are unloaded.

## Attribution

Based on the original **Claude Auto-Continue v1.3.0** by GitHub user [@timothy22000](https://github.com/timothy22000). This community build is maintained separately and is not endorsed by or affiliated with the original author. Original project: [github.com/timothy22000/claude-autocontinue](https://github.com/timothy22000/claude-autocontinue).

## Polling

The background tab check runs every 6 seconds, and the in-page fallback checks every 4 seconds. The extension attempts to dismiss visible Claude dialogs using their close/dismiss controls or Escape, then checks again for Retry or Continue. If a Retry or Continue control is detected but disappears before the extension can click it, the extension sends `Continue` only when the chat composer is empty. It does not send the fallback when no action control was detected in the first place, and it does not replace an existing draft.
