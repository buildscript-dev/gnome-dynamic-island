import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const IFACE = 'io.github.buildscript_dev.DynamicIsland';
const OBJ = '/io/github/buildscript_dev/DynamicIsland';

// Ask the running island to do something (for the "Try it" buttons).
function island(method, params = null) {
    Gio.DBus.session.call('org.gnome.Shell', OBJ, IFACE, method, params, null,
        Gio.DBusCallFlags.NONE, 2000, null, (c, r) => {
            try {
                c.call_finish(r);
            } catch (e) {
                console.warn(`Dynamic Island not reachable: ${e.message}`);
            }
        });
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({title, subtitle,
        model: Gtk.StringList.new(choices.map(c => c[1]))});
    const sync = () => {
        const i = choices.findIndex(c => c[0] === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    return row;
}

function spinRow(settings, key, title, lo, hi) {
    const row = new Adw.SpinRow({title,
        adjustment: new Gtk.Adjustment({lower: lo, upper: hi, step_increment: 1})});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function group(page, title, rows, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    rows.forEach(r => g.add(r));
    page.add(g);
    return g;
}

export default class DynamicIslandPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(640, 760);

        // --- General ---
        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(general);

        const tryRow = new Adw.ActionRow({title: 'Try it',
            subtitle: 'Show a sample alert, the volume HUD, or open the island'});
        for (const [label, fn] of [
            ['Alert', () => island('Alert', new GLib.Variant('(sss)', ['charging', 'Hello from settings', '100%']))],
            ['Volume', () => island('Hud', new GLib.Variant('(su)', ['volume', 60]))],
            ['Open', () => island('Expand')],
        ]) {
            const b = new Gtk.Button({label, valign: Gtk.Align.CENTER});
            b.connect('clicked', fn);
            tryRow.add_suffix(b);
        }
        group(general, '', [tryRow]);

        group(general, 'Island', [
            comboRow(s, 'style', 'Style', 'Shape measured from the MacBook Pro PROLED XDR, or the iPhone floating pill', [
                ['macbook', 'MacBook (attached to the top edge)'],
                ['floating', 'iPhone (floating pill)'],
            ]),
            comboRow(s, 'monitor', 'Screen', 'Where the island lives with an external monitor plugged in', [
                ['focused', 'Follow the window I work in'],
                ['laptop', 'Laptop screen'],
                ['external', 'External monitor'],
                ['primary', 'Primary display'],
            ]),
            switchRow(s, 'hide-top-bar', 'Hide the top bar',
                'Off + MacBook style: the island sits in the middle of the bar, like on a Mac'),
            switchRow(s, 'show-when-idle', 'Show when idle',
                'Off: the island hides until something happens, or you touch the top edge'),
            switchRow(s, 'show-clock', 'Clock in the island'),
        ]);

        const shortcut = new Adw.ActionRow({title: 'Keyboard shortcut', subtitle: 'Open or close the island'});
        shortcut.add_suffix(new Gtk.ShortcutLabel({
            accelerator: s.get_strv('toggle-shortcut')[0] ?? '', valign: Gtk.Align.CENTER}));
        group(general, 'Using it', [
            switchRow(s, 'open-on-hover', 'Open on hover'),
            comboRow(s, 'scroll-action', 'Scrolling on the island', '', [
                ['pages', 'Opens it and flips pages'],
                ['volume', 'Changes the volume'],
            ]),
            shortcut,
            switchRow(s, 'haptics', 'Tick sound on open'),
            switchRow(s, 'reduce-motion', 'Reduce motion', 'Settle without bouncing'),
        ], 'Hover or click to open. Scroll for Home, Controls and History. Middle-click plays or pauses. ' +
           'Right-click dismisses a notification.');

        // --- Laptop & phone ---
        const sync = new Adw.PreferencesPage({title: 'Devices', icon_name: 'computer-symbolic'});
        window.add(sync);
        group(sync, 'Takes over from GNOME', [
            switchRow(s, 'replace-osd', 'Volume and brightness', 'Show them in the island instead of GNOME\'s pop-up'),
            switchRow(s, 'show-notifications', 'Notifications', 'Show them in the island instead of GNOME\'s banners'),
        ]);
        group(sync, 'Alerts', [
            switchRow(s, 'laptop-alerts', 'Laptop',
                'Power mode, Night Light, audio output, Caps Lock and keyboard layout'),
            switchRow(s, 'show-workspaces', 'Workspace switches'),
            switchRow(s, 'show-mic-indicator', 'Microphone dot', 'Orange dot while an app records'),
            switchRow(s, 'phone-alerts', 'Phone',
                'Connection and battery through GSConnect. Phone notifications and calls always show'),
        ]);
        const pair = new Adw.ActionRow({title: 'Pair a phone',
            subtitle: 'Install KDE Connect on the phone, then pair it in GSConnect'});
        const pairBtn = new Gtk.Button({label: 'Open GSConnect', valign: Gtk.Align.CENTER});
        pairBtn.connect('clicked', () => {
            try {
                Gio.Subprocess.new(['gnome-extensions', 'prefs', 'gsconnect@andyholmes.github.io'],
                    Gio.SubprocessFlags.NONE);
            } catch {}
        });
        pair.add_suffix(pairBtn);
        group(sync, 'Phone', [pair]);

        const alarm = new Adw.EntryRow({title: 'Alarm (HH:MM, empty = none)', show_apply_button: true});
        alarm.text = s.get_string('alarm-time');
        alarm.connect('apply', () => {
            const t = alarm.text.trim();
            if (!t)
                island('AlarmCancel');
            else
                island('Alarm', new GLib.Variant('(s)', [t]));
        });
        group(sync, 'Alarm', [alarm]);

        // --- Music ---
        const music = new Adw.PreferencesPage({title: 'Music', icon_name: 'audio-x-generic-symbolic'});
        window.add(music);
        group(music, 'Now Playing', [
            switchRow(s, 'online-extras', 'Online extras',
                'Album art for streaming players and lyrics. Off = no network use'),
            switchRow(s, 'show-lyrics', 'Synced lyrics', 'From lrclib.net'),
            switchRow(s, 'use-cava', 'Real spectrum', 'Needs cava (brew install cava)'),
            switchRow(s, 'artwork-tint', 'Tint from album art'),
        ]);

        // --- Look ---
        const look = new Adw.PreferencesPage({title: 'Look', icon_name: 'applications-graphics-symbolic'});
        window.add(look);
        const clock = new Adw.EntryRow({title: 'Clock format (%H:%M = 24 h, %l:%M %p = 12 h)'});
        s.bind('clock-format', clock, 'text', Gio.SettingsBindFlags.DEFAULT);
        group(look, 'Size', [
            spinRow(s, 'island-width', 'Idle width', 60, 300),
            spinRow(s, 'island-height', 'Idle height', 20, 60),
            spinRow(s, 'pill-inset', 'Gap from top', 0, 40),
            spinRow(s, 'notification-width', 'Notification width', 300, 700),
            spinRow(s, 'hover-delay', 'Hover delay (ms)', 0, 2000),
            clock,
        ]);
    }
}
