# Dynamic Island for GNOME

A solid black, iPhone-style Dynamic Island for GNOME Shell 50, ported from
[omarchy-dynamic-island](https://github.com/buildscript-dev/omarchy-dynamic-island).
It springs open for music, timers, recording, notifications, volume, brightness
and system alerts, then gets out of the way. The GNOME top bar is hidden; it
comes back in the overview.

![preview](preview.png)

## Install

```sh
./install.sh            # links this folder into ~/.local/share/gnome-shell/extensions
# log out and back in once (Wayland), then:
gnome-extensions enable dynamic-island@buildscript-dev.github.io
```

Optional: `brew install cava` for a waveform that follows the real audio.
Settings: `gnome-extensions prefs dynamic-island@buildscript-dev.github.io`.

## What it shows

- **Idle**: a small pill with the clock.
- **Live activities**: music (art + album-tinted waveform), timer, stopwatch,
  screen recording (GNOME's recorder), ringing alarm. A second one detaches
  into a bubble beside the island.
- **HUD**: volume, brightness, keyboard backlight (replaces GNOME's OSD).
- **Alerts**: charging, on battery, low battery, Bluetooth, network, Do Not Disturb.
- **Notifications**: replace GNOME's banners. Click opens, right-click dismisses.
- **Expanded** (hover or click), scroll for pages: Now Playing with synced
  lyrics (lrclib.net) and a seekable scrubber, Home (clock, week, timers,
  stopwatch, Focus), History.
- Orange dot while an app uses the microphone.

## Gestures

Hover or click to open, scroll to page, middle-click play/pause,
right-click dismisses a notification or snoozes an alarm.

## D-Bus

```sh
I=io.github.buildscript_dev.DynamicIsland
call() { gdbus call --session -d org.gnome.Shell -o /io/github/buildscript_dev/DynamicIsland -m $I.$1 "${@:2}"; }
call Timer 300; call TimerCancel; call Stopwatch; call StopwatchReset
call Alarm 7:30; call AlarmCancel; call Expand; call Collapse; call State
call Alert charging "Hello" "42%"; call Hud volume 40
```

## Not yet ported

Genie minimize, phone (GSConnect), earbuds, call view.

## License

MIT. Not affiliated with Apple.
