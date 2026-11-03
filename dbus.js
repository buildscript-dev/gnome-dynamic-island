// Session D-Bus interface on the shell's connection, the GNOME stand-in for
// `omarchy-shell island ...`. Call it with:
//   gdbus call --session -d org.gnome.Shell -o /io/github/buildscript_dev/DynamicIsland \
//     -m io.github.buildscript_dev.DynamicIsland.Timer 300
// Every method only changes what the island shows; State reports kinds, not contents.

import Gio from 'gi://Gio';

import {G, plain} from './lib/model.js';

const IFACE = `<node>
<interface name="io.github.buildscript_dev.DynamicIsland">
  <method name="State"><arg type="s" direction="out"/></method>
  <method name="Expand"/>
  <method name="Collapse"/>
  <method name="Timer"><arg type="u" name="seconds" direction="in"/></method>
  <method name="TimerCancel"/>
  <method name="Stopwatch"/>
  <method name="StopwatchReset"/>
  <method name="Alarm"><arg type="s" name="time" direction="in"/><arg type="b" direction="out"/></method>
  <method name="AlarmCancel"/>
  <method name="AlarmStop"/>
  <method name="AlarmSnooze"/>
  <method name="Alert"><arg type="s" name="glyph" direction="in"/><arg type="s" name="title" direction="in"/><arg type="s" name="value" direction="in"/></method>
  <method name="Hud"><arg type="s" name="kind" direction="in"/><arg type="u" name="percent" direction="in"/></method>
</interface>
</node>`;

const GLYPHS = {volume: G.volHigh, brightness: G.brightHigh, keyboard: G.keyboard, mic: G.mic};

export class IslandDBus {
    constructor(island) {
        const i = island;
        const impl = {
            State: () => i.state(),
            Expand: () => i.expand(),
            Collapse: () => i.collapse(),
            Timer: s => i.timers.startTimer(Math.max(1, Math.min(s, 24 * 3600))),
            TimerCancel: () => i.timers.cancelTimer(),
            Stopwatch: () => i.timers.toggleStopwatch(),
            StopwatchReset: () => i.timers.resetStopwatch(),
            Alarm: t => i.timers.setAlarm(plain(t, 8)),
            AlarmCancel: () => i.timers.cancelAlarm(),
            AlarmStop: () => i.timers.stopAlarm(),
            AlarmSnooze: () => i.timers.snoozeAlarm(),
            Alert: (g, title, value) => i.push({kind: 'alert', source: 'dbus',
                icon: G[g] ?? (g ? [...g][0] : G.bell), tint: 'white',
                title: plain(title, 60), value: plain(value, 24)}),
            Hud: (kind, percent) => {
                const k = GLYPHS[kind] ? kind : 'volume';
                const p = Math.min(150, percent);
                i.push({kind: 'hud', source: k, icon: GLYPHS[k], tint: 'white', percent: p, value: `${p}%`,
                    duration: 1500});
            },
        };
        this._obj = Gio.DBusExportedObject.wrapJSObject(IFACE, impl);
        this._obj.export(Gio.DBus.session, '/io/github/buildscript_dev/DynamicIsland');
    }

    destroy() {
        this._obj.unexport();
        this._obj = null;
    }
}
