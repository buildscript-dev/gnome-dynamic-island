import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SWITCHES = {
    'Island': [
        ['hide-top-bar', 'Hide the top bar', 'Standalone island; the bar comes back in the overview'],
        ['show-when-idle', 'Show when idle', 'Off: the island hides until something happens, or you touch the top edge'],
        ['show-clock', 'Clock in the island', ''],
        ['open-on-hover', 'Open on hover', ''],
        ['reduce-motion', 'Reduce motion', 'Settle without bouncing'],
        ['haptics', 'Tick sound on open', ''],
    ],
    'Takes over': [
        ['replace-osd', 'Volume and brightness', 'Show them in the island instead of GNOME\'s pop-up'],
        ['show-notifications', 'Notifications', 'Show them in the island instead of GNOME\'s banners'],
        ['show-mic-indicator', 'Microphone dot', 'Orange dot while an app records'],
    ],
    'Music': [
        ['online-extras', 'Online extras', 'Album art for streaming players and lyrics. Off = no network use'],
        ['show-lyrics', 'Synced lyrics', 'From lrclib.net'],
        ['use-cava', 'Real spectrum', 'Needs cava (brew install cava)'],
        ['artwork-tint', 'Tint from album art', ''],
    ],
};

const SPINS = [
    ['island-width', 'Idle width', 60, 300],
    ['island-height', 'Idle height', 20, 60],
    ['pill-inset', 'Gap from top', 0, 40],
    ['notification-width', 'Notification width', 300, 700],
    ['hover-delay', 'Hover delay (ms)', 0, 2000],
];

export default class DynamicIslandPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Dynamic Island', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        for (const [title, rows] of Object.entries(SWITCHES)) {
            const group = new Adw.PreferencesGroup({title});
            for (const [key, name, sub] of rows) {
                const row = new Adw.SwitchRow({title: name, subtitle: sub});
                settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
                group.add(row);
            }
            page.add(group);
        }

        const size = new Adw.PreferencesGroup({title: 'Size'});
        for (const [key, name, lo, hi] of SPINS) {
            const row = new Adw.SpinRow({title: name,
                adjustment: new Gtk.Adjustment({lower: lo, upper: hi, step_increment: 1})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            size.add(row);
        }
        const clock = new Adw.EntryRow({title: 'Clock format (%H:%M, %l:%M %p)'});
        settings.bind('clock-format', clock, 'text', Gio.SettingsBindFlags.DEFAULT);
        size.add(clock);
        page.add(size);
    }
}
