// Media players over MPRIS. Tracks every org.mpris.MediaPlayer2.* name on the
// session bus and exposes the "active" one: the player that most recently
// started playing, else any paused player.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';

const PlayerIface = `<node>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/>
  <method name="Next"/>
  <method name="Previous"/>
  <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
  <method name="Seek"><arg type="x" direction="in"/></method>
  <signal name="Seeked"><arg type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
</interface>
</node>`;

const RootIface = `<node>
<interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
</interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);
const RootProxy = Gio.DBusProxy.makeProxyWrapper(RootIface);

class Player extends EventEmitter {
    constructor(busName, onReady) {
        super();
        this.busName = busName;
        this.status = 'Stopped';
        this.meta = {};
        this.lastPlayed = 0;
        this._posBase = 0;
        this._posTime = 0;
        this._cancel = new Gio.Cancellable();

        new PlayerProxy(Gio.DBus.session, busName, PATH, (proxy, error) => {
            if (error || this._cancel.is_cancelled())
                return;
            this._proxy = proxy;
            proxy.connect('g-properties-changed', () => this._sync());
            proxy.connectSignal('Seeked', (_p, _s, [pos]) => {
                this._setPosition(pos);
                this.emit('changed');
            });
            this._sync();
            this.refreshPosition();
            onReady(this);
        }, this._cancel);

        new RootProxy(Gio.DBus.session, busName, PATH, (proxy, error) => {
            if (error || this._cancel.is_cancelled())
                return;
            this._root = proxy;
            this.emit('changed');
        }, this._cancel);
    }

    get identity() {
        return this._root?.Identity || this.busName.slice(PREFIX.length).split('.')[0];
    }

    get desktopEntry() {
        return this._root?.DesktopEntry || '';
    }

    get playing() {
        return this.status === 'Playing';
    }

    get canSeek() {
        return !!this._proxy?.CanSeek && this.meta.length > 0;
    }

    _sync() {
        const p = this._proxy;
        const status = p.PlaybackStatus || 'Stopped';
        const raw = p.Metadata || {};
        const get = k => raw[k]?.deepUnpack?.() ?? raw[k];
        const artists = get('xesam:artist');
        const meta = {
            trackId: String(get('mpris:trackid') || ''),
            title: String(get('xesam:title') || ''),
            artist: Array.isArray(artists) ? artists.join(', ') : String(artists || ''),
            album: String(get('xesam:album') || ''),
            artUrl: String(get('mpris:artUrl') || ''),
            length: Number(get('mpris:length') || 0) / 1e6,
            url: String(get('xesam:url') || ''),
        };
        const trackChanged = meta.title !== this.meta.title || meta.artist !== this.meta.artist;
        if (status === 'Playing' && this.status !== 'Playing')
            this.lastPlayed = GLib.get_monotonic_time();
        if (status !== this.status) {
            // Freeze or restart the local clock at the current position.
            this._setPosition(this.position * 1e6);
        }
        this.status = status;
        this.meta = meta;
        if (trackChanged) {
            this._setPosition(0);
            this.refreshPosition();
            this.emit('track-changed');
        }
        this.emit('changed');
    }

    _setPosition(us) {
        this._posBase = Math.max(0, Number(us) / 1e6);
        this._posTime = GLib.get_monotonic_time();
    }

    // Seconds into the track, extrapolated while playing.
    get position() {
        let pos = this._posBase;
        if (this.playing)
            pos += (GLib.get_monotonic_time() - this._posTime) / 1e6;
        return this.meta.length > 0 ? Math.min(pos, this.meta.length) : pos;
    }

    refreshPosition() {
        Gio.DBus.session.call(this.busName, PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            null, Gio.DBusCallFlags.NONE, 1000, this._cancel, (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    this._setPosition(v.deepUnpack());
                    this.emit('changed');
                } catch {}
            });
    }

    playPause() {
        this._proxy?.PlayPauseAsync().catch(() => {});
    }

    next() {
        this._proxy?.NextAsync().catch(() => {});
    }

    // "Previous" restarts the track after 4 s, like Apple does.
    previous() {
        if (this.position > 4 && this.canSeek)
            this.seekTo(0);
        else
            this._proxy?.PreviousAsync().catch(() => {});
    }

    seekTo(seconds) {
        if (!this.canSeek)
            return;
        const id = this.meta.trackId;
        const us = Math.round(seconds * 1e6);
        if (id && GLib.Variant.is_object_path(id))
            this._proxy.SetPositionAsync(id, us).catch(() => {});
        else
            this._proxy.SeekAsync(Math.round(us - this.position * 1e6)).catch(() => {});
        this._setPosition(us);
        this.emit('changed');
    }

    raise() {
        this._root?.RaiseAsync().catch(() => {});
    }

    destroy() {
        this._cancel.cancel();
        this.disconnectAll?.();
    }
}

export class MprisService extends EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._cancel = new Gio.Cancellable();
        this._sub = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, -1,
            this._cancel, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(PREFIX)).forEach(n => this._add(n));
                } catch {}
            });
    }

    _add(name) {
        if (this._players.has(name))
            return;
        const player = new Player(name, () => this._changed());
        player.connect('changed', () => this._changed());
        player.connect('track-changed', () => {
            if (player === this.active)
                this.emit('track-changed', player);
        });
        this._players.set(name, player);
    }

    _remove(name) {
        const p = this._players.get(name);
        if (!p)
            return;
        p.destroy();
        this._players.delete(name);
        this._changed();
    }

    _changed() {
        const prev = this._active;
        this._active = this._pick();
        if (prev !== this._active && this._active)
            this.emit('track-changed', this._active);
        this.emit('changed');
    }

    _pick() {
        const all = [...this._players.values()].filter(p => p.meta.title);
        const playing = all.filter(p => p.playing).sort((a, b) => b.lastPlayed - a.lastPlayed);
        if (playing.length)
            return playing[0];
        if (this._active && all.includes(this._active))
            return this._active;
        return all.sort((a, b) => b.lastPlayed - a.lastPlayed)[0] ?? null;
    }

    get active() {
        return this._active ?? null;
    }

    get players() {
        return [...this._players.values()].filter(p => p.meta.title);
    }

    destroy() {
        this._cancel.cancel();
        Gio.DBus.session.signal_unsubscribe(this._sub);
        for (const p of this._players.values())
            p.destroy();
        this._players.clear();
    }
}
