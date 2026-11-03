// Phone continuity through GSConnect (KDE Connect for GNOME): which phones
// are connected and their battery, plus "find my phone". Phone notifications
// and calls already arrive as GNOME notifications, which the island shows.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {G, plain} from '../lib/model.js';

const NAME = 'org.gnome.Shell.Extensions.GSConnect';
const PATH = '/org/gnome/Shell/Extensions/GSConnect';
const DEVICE = 'org.gnome.Shell.Extensions.GSConnect.Device';
const STARTUP_QUIET_MS = 5000;

class Phone {
    constructor(path, props, onChange) {
        this.path = path;
        this.name = 'Phone';
        this.connected = false;
        this.paired = false;
        this.type = 'phone';
        this.battery = null;  // {level, charging}
        this.update(props);
        this._onChange = onChange;
        this.actions = Gio.DBusActionGroup.get(Gio.DBus.session, NAME, path);
        this._ids = [
            this.actions.connect('action-added', (_g, n) => n === 'battery' && this._readBattery()),
            this.actions.connect('action-removed', (_g, n) => n === 'battery' && this._readBattery()),
            this.actions.connect('action-state-changed', (_g, n) => n === 'battery' && this._readBattery()),
        ];
        // Listing the actions makes the group fetch them.
        this.actions.list_actions();
        this._readBattery();
    }

    update(props) {
        const get = k => props[k]?.unpack?.() ?? props[k];
        if ('Name' in props)
            this.name = plain(get('Name'), 40);
        if ('Connected' in props)
            this.connected = !!get('Connected');
        if ('Paired' in props)
            this.paired = !!get('Paired');
        if ('Type' in props)
            this.type = String(get('Type'));
    }

    _readBattery() {
        const prev = this.battery;
        this.battery = null;
        try {
            if (this.actions.has_action('battery')) {
                const [charging, , level] = this.actions.get_action_state('battery').deepUnpack();
                if (level >= 0)
                    this.battery = {level, charging};
            }
        } catch {}
        this._onChange?.(this, prev);
    }

    ring() {
        if (this.actions.has_action('ring'))
            this.actions.activate_action('ring', null);
    }

    destroy() {
        this._ids.forEach(id => this.actions.disconnect(id));
        this._onChange = null;
    }
}

export class PhoneService extends EventEmitter {
    constructor() {
        super();
        this._born = GLib.get_monotonic_time();
        this._phones = new Map();
        this._cancel = new Gio.Cancellable();
        const bus = Gio.DBus.session;
        this._subs = [
            bus.signal_subscribe(NAME, 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', PATH, null,
                Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path, ifaces] = params.deepUnpack();
                    if (ifaces[DEVICE])
                        this._add(path, ifaces[DEVICE]);
                }),
            bus.signal_subscribe(NAME, 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', PATH, null,
                Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path, ifaces] = params.deepUnpack();
                    if (ifaces.includes(DEVICE))
                        this._remove(path);
                }),
            bus.signal_subscribe(NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, DEVICE,
                Gio.DBusSignalFlags.NONE, (_c, _s, path, _i, _n, params) => {
                    const [, changed] = params.deepUnpack();
                    const phone = this._phones.get(path);
                    if (!phone)
                        return;
                    const was = phone.connected;
                    phone.update(changed);
                    if (phone.paired && was !== phone.connected)
                        this._announceConnection(phone);
                    this.emit('changed');
                }),
        ];
        this._watch = Gio.bus_watch_name(Gio.BusType.SESSION, NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._load(), () => this._clear());
    }

    get _quiet() {
        return (GLib.get_monotonic_time() - this._born) / 1000 < STARTUP_QUIET_MS;
    }

    _load() {
        Gio.DBus.session.call(NAME, PATH, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null, null,
            Gio.DBusCallFlags.NONE, 5000, this._cancel, (c, r) => {
                try {
                    const [objects] = c.call_finish(r).deepUnpack();
                    for (const [path, ifaces] of Object.entries(objects)) {
                        if (ifaces[DEVICE])
                            this._add(path, ifaces[DEVICE]);
                    }
                } catch {}
            });
    }

    _add(path, props) {
        if (this._phones.has(path))
            return;
        this._phones.set(path, new Phone(path, props, (p, prev) => this._onBattery(p, prev)));
        this.emit('changed');
    }

    _remove(path) {
        this._phones.get(path)?.destroy();
        this._phones.delete(path);
        this.emit('changed');
    }

    _clear() {
        for (const p of this._phones.values())
            p.destroy();
        this._phones.clear();
        this.emit('changed');
    }

    _announceConnection(p) {
        if (this._quiet)
            return;
        const level = p.battery ? `${p.battery.level}%` : '';
        this.emit('alert', {kind: 'alert', source: 'phone', icon: G.phone,
            tint: p.connected ? 'green' : 'secondary', title: p.name,
            value: p.connected ? (level || 'Connected') : 'Disconnected'});
    }

    _onBattery(p, prev) {
        this.emit('changed');
        const b = p.battery;
        if (this._quiet || !b || !prev || !p.connected)
            return;
        if (b.charging && !prev.charging) {
            this.emit('alert', {kind: 'alert', source: 'phone', icon: G.charging, tint: 'green',
                title: `${p.name} Charging`, value: `${b.level}%`});
        } else if (!b.charging && prev.level > 15 && b.level <= 15) {
            this.emit('alert', {kind: 'alert', source: 'phone', icon: G.batteryAlert, tint: 'red',
                title: `${p.name} Battery Low`, value: `${b.level}%`, duration: 4000});
        }
    }

    // Paired phones, connected first.
    get phones() {
        return [...this._phones.values()].filter(p => p.paired)
            .sort((a, b) => Number(b.connected) - Number(a.connected));
    }

    destroy() {
        this._cancel.cancel();
        this._subs.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        Gio.bus_unwatch_name(this._watch);
        this._clear();
    }
}
