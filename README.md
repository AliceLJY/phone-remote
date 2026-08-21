# phone-remote

**English** | [简体中文](README_CN.md)

Turn a phone into a wireless keyboard + shortcut pad for a Mac.

Open a web page on the phone, type or **dictate** into the text box (using the
phone's own keyboard/voice input), and tap buttons for arrows, Tab, Ctrl+C, ⌘
combos. Commands reach the Mac over your LAN/Tailscale and are injected as real
keyboard events into whatever window is frontmost.

<p align="center">
  <img src="docs/screenshot.jpeg" alt="phone-remote running on a phone" width="320">
  <br>
  <em>Running as a home-screen web app. Buttons are plain HTML — add your own.</em>
</p>

## Why

When you drive a headless/remote Mac through a remote-desktop tool, **voice
dictation doesn't reach it**: remote software forwards physical keypresses fine
but mangles IME composition, so dictated text (especially CJK) never lands.

phone-remote sidesteps that by injecting **locally on the target Mac** instead of
forwarding input across the remote session. Use the remote desktop to *see* the
screen and the phone to *type* — two separate paths. Chinese text and modifier
combos both work.

No app to install on the phone: it's a web page you "Add to Home Screen", so the
same setup works on iPhone and Android side by side.

## Install

```bash
git clone https://github.com/<you>/phone-remote.git ~/Projects/phone-remote
cd ~/Projects/phone-remote
./install.sh
```

`install.sh` builds a small signed `.app` wrapper into `~/Applications`, installs
a LaunchAgent (starts at login, restarts on crash), and starts the service.
Zero npm dependencies — Node's standard library only.

To run it in the foreground instead:

```bash
node server.js     # prints the tokenized phone URL
```

### One manual step: Accessibility

Synthesizing keystrokes requires Accessibility permission, which macOS grants
per executable:

> System Settings → Privacy & Security → Accessibility → **+** → Applications →
> **Phone Remote** → toggle on

Then `launchctl kickstart -k gui/$(id -u)/<label>`. Until this is granted,
`/type` and `/key` return a `not allowed to send keystrokes (1002)` error.

## Use it from the phone

The startup log (`~/ops-logs/phone-remote/stdout.log`) prints a tokenized URL:

```
http://100.x.y.z:8787/?t=<token>
```

Open it on the phone (over Tailscale, or `<your-mac>.local:8787` on the same
LAN), then **Add to Home Screen** — it becomes a full-screen app that carries
its own token, indistinguishable from a native one.

Make sure the target Mac's frontmost window is where you want the text to land.

## Customizing buttons

Buttons are plain HTML in `index.html`:

```html
<button onclick="key('ctrl-r')">^R</button>
```

`key()` takes any name from the `KEYS` whitelist in `server.js`; add a row there
to support a new one (`{ code: <AppleScript key code> }` or
`{ char: "x", mods: ["cmd","shift"] }`).

## Security

- Bind is LAN/Tailscale only — do **not** port-forward this to the internet.
  Anything that can reach the port and holds the token owns your keyboard.
- Every injection endpoint checks a token stored in `.token` (gitignored,
  mode 600, generated on first run). Requests without it get a 401.
- User input is never concatenated into a shell or AppleScript command: text is
  passed via a temp file and read with `read POSIX file … as «class utf8»`,
  shortcuts go through a fixed whitelist. No injection surface.

## Notes / limitations

- Text injection goes through the clipboard (temp file → clipboard → ⌘V), so it
  **overwrites the Mac's current clipboard**.
- `pbcopy` is deliberately unused: in a non-Aqua/background session it silently
  fails to reach the GUI pasteboard (writes appear to succeed, `pbpaste` reads
  back empty). `osascript`'s `the clipboard` goes through AppKit and works.
- Keys land in the frontmost window — if another app steals focus, they go there.

MIT licensed.
