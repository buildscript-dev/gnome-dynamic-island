// System events for the island: battery, Bluetooth, Wi-Fi, Do Not Disturb,
// GNOME's screen recorder and microphone use. Each one emits 'alert' with an
// activity payload, or 'changed' for live state (recording, mic).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import NM from 'gi://NM';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {G, batteryGlyph} from '../lib/model.js';

// Events fired while everything is still starting up are initial state, not news.
const STARTUP_QUIET_MS = 4000;

const UPOWER_CHARGING = 1, UPOWER_DISCHARGING = 2, UPOWER_FULL = 4, UPOWER_PENDING_CHARGE = 5;

export class SystemService extends EventEmitter {
    constructor() {
        super();
        this._cancel = new Gio.Cancellable();
        this._born = GLib.get_monotonic_time();
        this._subs = [];
        this.recording = false;
        this.recordingStart = 0;
        this.micInUse = false;
        this.battery = {present: false, percent: 0, charging: false};

        this._initBattery();
        this._initBluetooth();
        this._initNetwork();
        this._initDnd();
        this._initRecording();
        this._initMic();
    }

    get nm() {
        return this._nm ?? null;
    }

    get _quiet() {
        return (GLib.get_monotonic_time() - this._born) / 1000 < STARTUP_QUIET_MS;
    }

    _alert(a) {
        if (!this._quiet)
            this.emit('alert', a);
    }

    // --- battery ------------------------------------------------------------

    _initBattery() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', this._cancel, (_o, res) => {
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(res);
                } catch {
                    return;
                }
                this._upower.connect('g-properties-changed', () => this._syncBattery(true));
                this._syncBattery(false);
            });
    }

    _syncBattery(announce) {
        const p = this._upower;
        const get = k => p.get_cached_property(k)?.unpack();
        const type = get('Type');
        const present = !!get('IsPresent') && type === 2;
        const percent = Math.round(get('Percentage') ?? 0);
        const state = get('State');
        const charging = state === UPOWER_CHARGING || state === UPOWER_FULL || state === UPOWER_PENDING_CHARGE;
        const prev = this.battery;
        this.battery = {present, percent, charging};
        this.emit('changed');
        if (!announce || !present || !prev.present)
            return;
        if (charging && !prev.charging) {
            this._alert({kind: 'alert', source: 'battery', icon: G.charging, tint: 'green',
                title: 'Charging', value: `${percent}%`, ring: percent});
        } else if (!charging && prev.charging && state === UPOWER_DISCHARGING) {
            this._alert({kind: 'alert', source: 'battery', icon: batteryGlyph(percent, false),
                tint: 'white', title: 'On Battery', value: `${percent}%`});
        } else if (!charging) {
            for (const level of [20, 10, 5]) {
                if (prev.percent > level && percent <= level) {
                    this._alert({kind: 'alert', source: 'battery', icon: G.batteryAlert, tint: 'red',
                        title: 'Low Battery', value: `${percent}%`, duration: 4000});
                    break;
                }
            }
        }
    }

    // --- bluetooth ------------------------------------------------------------

    _initBluetooth() {
        const sub = Gio.DBus.system.signal_subscribe('org.bluez',
            'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, 'org.bluez.Device1',
            Gio.DBusSignalFlags.NONE, (_c, _s, path, _i, _sig, params) => {
                const [, changed] = params.deepUnpack();
                if (!('Connected' in changed))
                    return;
                const connected = changed.Connected.unpack();
                this._bluezDevice(path, (name, icon, battery) => {
                    const phones = /audio|head/.test(icon);
                    this._alert({kind: 'alert', source: 'bluetooth',
                        icon: phones ? G.headphones : G.bluetooth,
                        tint: connected ? 'blue' : 'secondary',
                        title: name,
                        value: connected ? (battery >= 0 ? `${battery}%` : 'Connected') : 'Disconnected'});
                });
            });
        this._subs.push([Gio.DBus.system, sub]);
    }

    _bluezDevice(path, cb) {
        Gio.DBus.system.call('org.bluez', path, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['org.bluez.Device1']), null, Gio.DBusCallFlags.NONE, 2000,
            this._cancel, (conn, res) => {
                let name = 'Bluetooth', icon = '';
                try {
                    const [props] = conn.call_finish(res).deepUnpack();
                    name = props.Alias?.unpack() || props.Name?.unpack() || name;
                    icon = props.Icon?.unpack() || '';
                } catch {}
                Gio.DBus.system.call('org.bluez', path, 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', ['org.bluez.Battery1', 'Percentage']), null,
                    Gio.DBusCallFlags.NONE, 1000, this._cancel, (c2, r2) => {
                        let battery = -1;
                        try {
                            battery = c2.call_finish(r2).deepUnpack()[0].unpack();
                        } catch {}
                        cb(name, icon, battery);
                    });
            });
    }

    // --- network --------------------------------------------------------------

    _initNetwork() {
        NM.Client.new_async(this._cancel, (_o, res) => {
            try {
                this._nm = NM.Client.new_finish(res);
            } catch {
                return;
            }
            this._lastConn = this._nm.primary_connection?.get_id() ?? null;
            this._nmWifiId = this._nm.connect('notify::wireless-enabled', () => this.emit('changed'));
            this.emit('changed');
            this._nmId = this._nm.connect('notify::primary-connection', () => {
                const conn = this._nm.primary_connection;
                const id = conn?.get_id() ?? null;
                if (id === this._lastConn)
                    return;
                this._lastConn = id;
                const wifi = conn?.get_connection_type() === '802-11-wireless';
                if (!conn) {
                    this._alert({kind: 'alert', source: 'network', icon: G.wifi, tint: 'secondary',
                        title: 'Offline', value: ''});
                } else if (!conn.get_connection_type().startsWith('vpn') &&
                           conn.get_connection_type() !== 'loopback') {
                    this._alert({kind: 'alert', source: 'network', icon: G.wifi, tint: 'blue',
                        title: id, value: wifi ? 'Wi-Fi' : 'Connected'});
                }
            });
        });
    }

    // --- do not disturb -------------------------------------------------------

    _initDnd() {
        this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._dndId = this._notifSettings.connect('changed::show-banners', () => {
            const dnd = !this._notifSettings.get_boolean('show-banners');
            this._alert({kind: 'alert', source: 'dnd', icon: dnd ? G.moon : G.bell,
                tint: dnd ? 'indigo' : 'white', title: 'Do Not Disturb', value: dnd ? 'On' : 'Off'});
            this.emit('changed');
        });
    }

    get dnd() {
        return !this._notifSettings.get_boolean('show-banners');
    }

    set dnd(v) {
        this._notifSettings.set_boolean('show-banners', !v);
    }

    // --- screen recording -----------------------------------------------------

    _initRecording() {
        const ui = Main.screenshotUI;
        this._recId = ui.connect('notify::screencast-in-progress', () => {
            const on = ui.screencast_in_progress;
            if (on === this.recording)
                return;
            this.recording = on;
            if (on) {
                this.recordingStart = GLib.get_monotonic_time();
            } else {
                const secs = (GLib.get_monotonic_time() - this.recordingStart) / 1e6;
                this.emit('recording-finished', secs);
            }
            this.emit('changed');
        });
        this.recording = ui.screencast_in_progress;
        if (this.recording)
            this.recordingStart = GLib.get_monotonic_time();
    }

    stopRecording() {
        Main.screenshotUI.stopScreencast();
    }

    // --- microphone -----------------------------------------------------------

    _initMic() {
        this._mixer = Volume.getMixerControl();
        this._mixerIds = ['stream-added', 'stream-removed', 'stream-changed', 'state-changed']
            .map(sig => this._mixer.connect(sig, () => this._syncMic()));
        this._syncMic();
    }

    _syncMic() {
        if (this._mixer.get_state() !== Gvc.MixerControlState.READY)
            return;
        const skipped = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];
        const inUse =
            this._mixer.get_sources().some(s => s.state === Gvc.MixerStreamState.RUNNING) &&
            this._mixer.get_source_outputs().some(o => !skipped.includes(o.get_application_id()));
        if (inUse !== this.micInUse) {
            this.micInUse = inUse;
            this.emit('changed');
        }
    }

    // Volume step on the default output, used by scrolling on the island.
    nudgeVolume(deltaPercent) {
        const sink = this._mixer.get_default_sink();
        if (!sink)
            return null;
        const max = this._mixer.get_vol_max_norm();
        const vol = Math.max(0, Math.min(max, sink.volume + max * deltaPercent / 100));
        sink.volume = vol;
        if (sink.is_muted && vol > 0)
            sink.change_is_muted(false);
        sink.push_volume();
        return Math.round(vol * 100 / max);
    }

    destroy() {
        this._cancel.cancel();
        for (const [bus, id] of this._subs)
            bus.signal_unsubscribe(id);
        if (this._nm && this._nmId)
            this._nm.disconnect(this._nmId);
        if (this._nm && this._nmWifiId)
            this._nm.disconnect(this._nmWifiId);
        if (this._dndId)
            this._notifSettings.disconnect(this._dndId);
        if (this._recId)
            Main.screenshotUI.disconnect(this._recId);
        for (const id of this._mixerIds ?? [])
            this._mixer.disconnect(id);
    }
}
