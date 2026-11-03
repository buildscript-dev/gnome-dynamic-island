// Laptop controls and state for the Control Center page and its alerts:
// power mode, Night Light, dark style, Stay Awake, Wi-Fi, Bluetooth,
// volume, brightness, audio output, Caps Lock, keyboard layout, workspaces.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {G, PROFILES, friendlyOutput, plain} from '../lib/model.js';

const STARTUP_QUIET_MS = 4000;

function setProp(bus, name, path, iface, prop, variant, cancel) {
    bus.call(name, path, 'org.freedesktop.DBus.Properties', 'Set',
        new GLib.Variant('(ssv)', [iface, prop, variant]), null, Gio.DBusCallFlags.NONE, 3000,
        cancel, (c, r) => {
            try {
                c.call_finish(r);
            } catch (e) {
                console.warn(`[dynamic-island] set ${prop}: ${e.message}`);
            }
        });
}

export class LaptopService extends EventEmitter {
    constructor(system) {
        super();
        this._system = system;
        this._cancel = new Gio.Cancellable();
        this._born = GLib.get_monotonic_time();
        this._ids = [];
        this.profile = null;
        this.profiles = [];
        this.stayAwake = false;
        this._inhibitCookie = 0;

        this._initPowerProfiles();
        this._initRfkill();
        this._initSettings();
        this._initAudio();
        this._initKeyboard();
        this._initWorkspaces();
    }

    get _quiet() {
        return (GLib.get_monotonic_time() - this._born) / 1000 < STARTUP_QUIET_MS;
    }

    _alert(a) {
        if (!this._quiet)
            this.emit('alert', a);
    }

    _on(obj, sig, fn) {
        this._ids.push([obj, obj.connect(sig, fn)]);
    }

    // --- power mode ---------------------------------------------------------

    _initPowerProfiles() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles',
            'org.freedesktop.UPower.PowerProfiles', this._cancel, (_o, res) => {
                try {
                    this._ppd = Gio.DBusProxy.new_for_bus_finish(res);
                } catch {
                    return;
                }
                if (!this._ppd.g_name_owner)
                    return;
                this._on(this._ppd, 'g-properties-changed', () => this._syncProfile(true));
                this._syncProfile(false);
            });
    }

    _syncProfile(announce) {
        const active = this._ppd.get_cached_property('ActiveProfile')?.unpack() ?? null;
        const list = this._ppd.get_cached_property('Profiles')?.deepUnpack() ?? [];
        this.profiles = list.map(p => p.Profile?.unpack?.() ?? p.Profile).filter(Boolean);
        const changed = active !== this.profile;
        this.profile = active;
        this.emit('changed');
        if (announce && changed && PROFILES[active]) {
            const p = PROFILES[active];
            this._alert({kind: 'alert', source: 'power', icon: p.glyph, tint: p.tint, title: p.name, value: 'Power Mode'});
        }
    }

    cycleProfile() {
        if (!this._ppd || !this.profiles.length)
            return;
        const order = ['power-saver', 'balanced', 'performance'].filter(p => this.profiles.includes(p));
        const next = order[(order.indexOf(this.profile) + 1) % order.length];
        setProp(Gio.DBus.system, 'org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles',
            'org.freedesktop.UPower.PowerProfiles', 'ActiveProfile', new GLib.Variant('s', next), this._cancel);
    }

    // --- wi-fi and bluetooth ----------------------------------------------------

    _initRfkill() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            'org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
            'org.gnome.SettingsDaemon.Rfkill', this._cancel, (_o, res) => {
                try {
                    this._rfkill = Gio.DBusProxy.new_for_bus_finish(res);
                } catch {
                    return;
                }
                this._on(this._rfkill, 'g-properties-changed', () => this.emit('changed'));
                this.emit('changed');
            });
    }

    get bluetoothAvailable() {
        return !!this._rfkill?.get_cached_property('BluetoothHasAirplaneMode')?.unpack();
    }

    get bluetoothOn() {
        return this.bluetoothAvailable && !this._rfkill.get_cached_property('BluetoothAirplaneMode')?.unpack();
    }

    toggleBluetooth() {
        if (!this.bluetoothAvailable)
            return;
        setProp(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
            'org.gnome.SettingsDaemon.Rfkill', 'BluetoothAirplaneMode', new GLib.Variant('b', this.bluetoothOn),
            this._cancel);
    }

    get wifiOn() {
        return !!this._system.nm?.wireless_enabled;
    }

    get wifiName() {
        const c = this._system.nm?.primary_connection;
        return c?.get_connection_type() === '802-11-wireless' ? c.get_id() : '';
    }

    toggleWifi() {
        const nm = this._system.nm;
        if (!nm)
            return;
        nm.dbus_set_property('/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager',
            'WirelessEnabled', new GLib.Variant('b', !nm.wireless_enabled), -1, this._cancel, (c, r) => {
                try {
                    c.dbus_set_property_finish(r);
                } catch (e) {
                    console.warn(`[dynamic-island] wifi: ${e.message}`);
                }
            });
    }

    // --- night light, dark style, stay awake --------------------------------------

    _initSettings() {
        this._color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._on(this._color, 'changed::night-light-enabled', () => {
            const on = this.nightLight;
            this._alert({kind: 'alert', source: 'night-light', icon: on ? G.moonStars : G.sun,
                tint: on ? 'orange' : 'white', title: 'Night Light', value: on ? 'On' : 'Off'});
            this.emit('changed');
        });
        this._on(this._iface, 'changed::color-scheme', () => this.emit('changed'));
    }

    get nightLight() {
        return this._color.get_boolean('night-light-enabled');
    }

    toggleNightLight() {
        this._color.set_boolean('night-light-enabled', !this.nightLight);
    }

    get darkStyle() {
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    toggleDarkStyle() {
        this._iface.set_string('color-scheme', this.darkStyle ? 'default' : 'prefer-dark');
    }

    toggleStayAwake() {
        const bus = Gio.DBus.session;
        if (this.stayAwake) {
            bus.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
                'Uninhibit', new GLib.Variant('(u)', [this._inhibitCookie]), null, Gio.DBusCallFlags.NONE, -1,
                null, (c, r) => {
                    try {
                        c.call_finish(r);
                    } catch {}
                });
            this._inhibitCookie = 0;
            this.stayAwake = false;
        } else {
            // 4 = suspend, 8 = idle
            bus.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
                'Inhibit', new GLib.Variant('(susu)', ['dynamic-island', 0, 'Stay Awake', 12]),
                new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, this._cancel, (c, r) => {
                    try {
                        [this._inhibitCookie] = c.call_finish(r).deepUnpack();
                    } catch {
                        this.stayAwake = false;
                        this.emit('changed');
                    }
                });
            this.stayAwake = true;
        }
        this.emit('alert', {kind: 'alert', source: 'stay-awake', icon: G.coffee,
            tint: this.stayAwake ? 'orange' : 'white', title: 'Stay Awake', value: this.stayAwake ? 'On' : 'Off'});
        this.emit('changed');
    }

    // --- volume, brightness, audio output ------------------------------------------

    _initAudio() {
        this._mixer = Volume.getMixerControl();
        this._on(this._mixer, 'default-sink-changed', (_m, id) => {
            const sink = this._mixer.lookup_stream_id(id);
            if (!sink)
                return;
            const desc = sink.get_description() || sink.get_name() || 'Output';
            if (desc === this._lastSink)
                return;
            const first = this._lastSink === undefined;
            this._lastSink = desc;
            if (first)
                return;
            const name = friendlyOutput(desc);
            const phones = /bud|pod|head|bluez|bluetooth|bt |wh-|wf-|earphone/i.test(desc + sink.get_name());
            this._alert({kind: 'alert', source: 'output', icon: phones ? G.headphones : G.volHigh, tint: 'blue',
                title: plain(name, 50), value: ''});
            this.emit('changed');
        });
        const sink = this._mixer.get_default_sink();
        if (sink)
            this._lastSink = sink.get_description();
    }

    get volume() {
        const sink = this._mixer.get_state() === Gvc.MixerControlState.READY ? this._mixer.get_default_sink() : null;
        if (!sink)
            return null;
        return {percent: Math.round(sink.volume * 100 / this._mixer.get_vol_max_norm()), muted: sink.is_muted};
    }

    setVolume(fraction) {
        const sink = this._mixer.get_default_sink();
        if (!sink)
            return;
        sink.volume = Math.round(Math.max(0, Math.min(1, fraction)) * this._mixer.get_vol_max_norm());
        if (sink.is_muted && fraction > 0)
            sink.change_is_muted(false);
        sink.push_volume();
        this.emit('changed');
    }

    toggleMute() {
        const sink = this._mixer.get_default_sink();
        sink?.change_is_muted(!sink.is_muted);
        this.emit('changed');
    }

    get brightness() {
        const scale = Main.brightnessManager?.globalScale;
        return scale ? scale.value : null;
    }

    setBrightness(fraction) {
        const scale = Main.brightnessManager?.globalScale;
        if (scale)
            scale.value = Math.max(0.01, Math.min(1, fraction));
        this.emit('changed');
    }

    // --- keyboard ---------------------------------------------------------------

    _initKeyboard() {
        const keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        this._caps = keymap.get_caps_lock_state();
        this._on(keymap, 'state-changed', () => {
            const caps = keymap.get_caps_lock_state();
            if (caps === this._caps)
                return;
            this._caps = caps;
            this._alert({kind: 'alert', source: 'caps', icon: G.textAa, tint: caps ? 'yellow' : 'white',
                title: 'Caps Lock', value: caps ? 'On' : 'Off', duration: 1400});
        });
        const ism = getInputSourceManager();
        this._on(ism, 'current-source-changed', () => {
            const src = ism.currentSource;
            if (!src || Object.keys(ism.inputSources).length < 2)
                return;
            this._alert({kind: 'alert', source: 'keyboard', icon: G.keyboard, tint: 'white',
                title: plain(src.displayName, 40), value: src.shortName ?? '', duration: 1400});
        });
    }

    // --- workspaces ---------------------------------------------------------------

    _initWorkspaces() {
        const wm = global.workspace_manager;
        this._on(wm, 'active-workspace-changed', () => {
            if (this._quiet)
                return;
            this.emit('workspace', {index: wm.get_active_workspace_index(), count: wm.get_n_workspaces()});
        });
    }

    // --- actions ------------------------------------------------------------------

    lock() {
        SystemActions.getDefault().activateLockScreen();
    }

    powerMenu() {
        SystemActions.getDefault().activatePowerOff();
    }

    screenshot() {
        SystemActions.getDefault().activateScreenshotUI();
    }

    openSettings(panel = '') {
        try {
            const args = ['gnome-control-center'];
            if (panel)
                args.push(panel);
            Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`[dynamic-island] settings: ${e.message}`);
        }
    }

    destroy() {
        this._cancel.cancel();
        for (const [obj, id] of this._ids) {
            try {
                obj.disconnect(id);
            } catch {}
        }
        this._ids = [];
        if (this.stayAwake)
            this.toggleStayAwake();
    }
}
