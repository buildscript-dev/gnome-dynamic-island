// The island: one black pill that changes shape with springs, plus a small
// detached bubble for a second live activity. Owns the activity queue and
// gestures; services feed it events.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {G, geometry, macbookShape, plain, formatTime} from './lib/model.js';
import {Spring, SpringDriver} from './lib/spring.js';
import {glyph} from './views/widgets.js';
import {IdleView, CompactView, HudView, AlertView, NotificationView, ExpandedView, WorkspaceView, liveGlyph} from './views/views.js';

const NOTIFICATION_MS = 5000;
const CRITICAL_MS = 12000;
const HOVER_CLOSE_MS = 300;
const HISTORY_MAX = 40;
const BUBBLE_GAP = 6;

export class Island {
    constructor({settings, path, mpris, media, system, timers, hooks, laptop, phone}) {
        this.laptop = laptop;
        this.phone = phone;
        this.settings = settings;
        this.path = path;
        this.mpris = mpris;
        this.media = media;
        this.system = system;
        this.timers = timers;
        this.hooks = hooks;
        this.history = [];

        this._transient = null;     // hud / alert / notification on screen
        this._queue = [];           // notifications waiting
        this._expanded = false;
        this._openedByHover = false;
        this._page = 0;
        this._tucked = new Set();
        this._revealed = false;
        this._viewKey = null;
        this._view = null;
        this._timeouts = new Map();
        this._signals = [];
        this._seq = 0;

        this._build();
        this._connect();
        this._sync(true);
    }

    get idleWidth() {
        return this.settings.get_int('island-width');
    }

    get idleHeight() {
        // MacBook style with the top bar shown: the island is as tall as the bar,
        // like the island and the macOS menu bar.
        if (this.macbook && this._panelShown)
            return Math.max(20, Math.round(Main.panel.height || this.settings.get_int('island-height')));
        return this.settings.get_int('island-height');
    }

    get macbook() {
        return this.settings.get_string('style') === 'macbook';
    }

    get _panelShown() {
        return !this.settings.get_boolean('hide-top-bar');
    }

    // With the island in the middle of the top bar, it takes over the clock.
    _syncPanelClock() {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock)
            return;
        const hide = this.macbook && this._panelShown;
        if (hide && !this._clockHidden) {
            clock.hide();
            this._clockHidden = true;
        } else if (!hide && this._clockHidden) {
            clock.show();
            this._clockHidden = false;
        }
    }

    // --- construction -----------------------------------------------------------

    _build() {
        this.pill = new St.Widget({
            name: 'dynamicIsland',
            style_class: 'di-pill',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });
        this._stage = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.pill.add_child(this._stage);
        this._micDot = new St.Widget({width: 6, height: 6, style_class: 'di-mic-dot', visible: false});
        this.pill.add_child(this._micDot);
        // GNOME can tear the stage down before disable() runs (shell exit).
        this.pill.connect('destroy', () => (this._destroyed = true));

        this.bubble = new St.Widget({
            style_class: 'di-pill',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            visible: false,
        });
        this._bubbleGlyph = glyph(G.music, {size: 15});
        this.bubble.add_child(this._bubbleGlyph);

        // Thin strip at the top edge that reveals a hidden island.
        this._edge = new St.Widget({reactive: true, track_hover: true, height: 3, width: 240, opacity: 0});

        const opts = {trackFullscreen: true};
        Main.layoutManager.addTopChrome(this.pill, opts);
        Main.layoutManager.addTopChrome(this.bubble, opts);
        Main.layoutManager.addTopChrome(this._edge, opts);

        const h = this.idleHeight, w = this.idleWidth;
        this._driver = new SpringDriver(this.pill, () => this._applyGeometry());
        this._w = this._driver.add(new Spring(w, {epsilon: 0.25}));
        this._h = this._driver.add(new Spring(h, {epsilon: 0.25}));
        this._r = this._driver.add(new Spring(h / 2, {epsilon: 0.1}));
        this._split = this._driver.add(new Spring(0, {spring: 3.6, damping: 0.35, epsilon: 0.002}));
        this._squish = this._driver.add(new Spring(0, {spring: 5, damping: 0.22, epsilon: 0.002}));
        this._applyGeometry();
    }

    _connect() {
        const on = (obj, sig, fn) => this._signals.push([obj, obj.connect(sig, fn)]);

        on(this.pill, 'notify::hover', () => this._onHover());
        on(this.pill, 'button-press-event', () => {
            this._squish.jump(0);
            this._squish.velocity = 3;
            this._squish.active = true;
            this._driver.kick();
            return Clutter.EVENT_PROPAGATE;
        });
        on(this.pill, 'button-release-event', (_a, e) => this._onClick(e.get_button()));
        on(this.pill, 'scroll-event', (_a, e) => this._onScroll(e));
        on(this.bubble, 'button-release-event', () => {
            const second = this._live()[1];
            if (second) {
                this._expand(true, false, this.pages().indexOf(second.kind === 'music' ? 'player' : 'home'));
            }
            return Clutter.EVENT_STOP;
        });
        on(this._edge, 'notify::hover', () => {
            if (this._edge.hover) {
                this._revealed = true;
                this._sync();
            }
        });

        on(this.mpris, 'changed', () => this._onMedia());
        on(this.mpris, 'track-changed', (_m, p) => this._onTrack(p));
        on(this.media, 'art-changed', () => this._refresh());
        on(this.media, 'lyrics-changed', () => this._refresh());
        on(this.media, 'spectrum', () => this._refresh());
        on(this.system, 'alert', (_s, a) => this.push(a));
        on(this.system, 'changed', () => this._sync());
        on(this.system, 'recording-finished', (_s, secs) => {
            this._addHistory({icon: G.record, tint: 'red', title: 'Screen Recording', body: formatTime(secs)});
            this.push({kind: 'alert', source: 'recording', icon: G.record, tint: 'red',
                title: 'Recording Saved', value: formatTime(secs)});
        });
        on(this.timers, 'changed', () => this._sync());
        on(this.timers, 'tick', () => this._refresh());
        on(this.timers, 'timer-done', (_t, total) => {
            this._addHistory({icon: G.timer, tint: 'orange', title: 'Timer', body: `${formatTime(total)} done`});
            this.push({kind: 'alert', source: 'timer', icon: G.timer, tint: 'orange', title: 'Timer Done',
                value: formatTime(total), duration: 4000});
            this._playTheme('complete');
        });
        on(this.timers, 'alarm-ring', () => {
            this._addHistory({icon: G.alarm, tint: 'orange', title: 'Alarm', body: 'Rang'});
            this._playTheme('alarm-clock-elapsed');
        });
        on(this.timers, 'stopwatch-finished', (_t, secs) =>
            this._addHistory({icon: G.stopwatch, tint: 'orange', title: 'Stopwatch', body: formatTime(secs)}));
        on(this.hooks, 'osd', (_h, a) => this.push(a));
        on(this.laptop, 'alert', (_l, a) => {
            const userAction = a.source === 'stay-awake';
            if (userAction || this.settings.get_boolean('laptop-alerts'))
                this.push(a);
        });
        on(this.laptop, 'changed', () => this._refresh());
        on(this.laptop, 'workspace', (_l, w) => {
            if (this.settings.get_boolean('show-workspaces') && !this._expanded)
                this.push({kind: 'workspace', ...w, duration: 900});
        });
        on(this.phone, 'alert', (_p, a) => {
            if (this.settings.get_boolean('phone-alerts'))
                this.push(a);
        });
        on(this.phone, 'changed', () => this._refresh());
        on(global.display, 'notify::focus-window', () => this._followMonitor());
        on(Main.layoutManager, 'monitors-changed', () => this._followMonitor());
        on(this.hooks, 'notification', (_h, n) => this._onNotification(n));

        on(this.settings, 'changed', (_s, key) => {
            if (key === 'monitor')
                this._followMonitor();
            if (key !== 'first-run' && key !== 'alarm-time')
                this._sync(true);
        });
        on(Main.layoutManager, 'monitors-changed', () => {
            this._monitor = null;
            this._applyGeometry();
        });
        on(Main.overview, 'showing', () => this._sync());
        on(Main.overview, 'hidden', () => this._sync());

        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._fastTickId = 0;

        Main.wm.addKeybinding('toggle-shortcut', this.settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._expand(!this._expanded, false));

        if (this.settings.get_boolean('first-run')) {
            this._arm('welcome', 2500, () => {
                this.push({kind: 'alert', source: 'welcome', icon: G.music, tint: 'blue',
                    title: 'Hover or click me', value: 'Dynamic Island', duration: 5000});
                this.settings.set_boolean('first-run', false);
            });
        }
    }

    // --- public API (also used over D-Bus) ---------------------------------------

    // Show a transient activity: {kind: 'hud'|'alert', icon, tint, title, value, percent, duration}.
    push(a) {
        if (!a)
            return undefined;
        a.id = ++this._seq;
        if (this._expanded && a.kind === 'hud')
            return this._flashHudWhileExpanded(a);
        // A HUD of the same source updates in place.
        if (a.kind === 'hud' && this._transient?.kind === 'hud' && this._transient.source === a.source) {
            this._transient = a;
            this._view?.set?.(a);
            this._arm('transient', a.duration ?? 1500, () => this._endTransient());
            return undefined;
        }
        if (a.kind === 'notification' && this._transient && this._transient.kind !== 'notification') {
            this._queue.push(a);
            return undefined;
        }
        if (a.kind === 'notification' && this._transient?.kind === 'notification') {
            this._queue.push(a);
            return undefined;
        }
        if (this._transient?.kind === 'notification' && a.kind !== 'notification')
            this._queue.unshift(this._transient);
        this._transient = a;
        const ms = a.duration ?? (a.kind === 'hud' ? 1500 : 2200);
        this._arm('transient', ms, () => this._endTransient());
        this._sync();
        return undefined;
    }

    expand() {
        this._expand(true, false);
    }

    collapse() {
        this._expand(false);
    }

    state() {
        return JSON.stringify({
            mode: this._mode,
            expanded: this._expanded,
            page: this.pages()[this._page] ?? null,
            transient: this._transient?.kind ?? null,
            queued: this._queue.length,
            live: this._live().map(l => l.kind),
            width: Math.round(this._w.target),
            height: Math.round(this._h.target),
        });
    }

    pages() {
        const pages = [];
        if (this.mpris.active)
            pages.push('player');
        pages.push('home', 'controls', 'history');
        return pages;
    }

    // --- events ---------------------------------------------------------------

    _onMedia() {
        const p = this.mpris.active;
        if (p) {
            this.media.updateArt(p.meta.artUrl);
            this.media.updateLyrics(p.meta);
        } else {
            this.media.updateArt('');
        }
        this.media.setPlaying(!!p?.playing, GLib.build_filenamev([this.path, 'cava.conf']));
        if (p?.playing)
            this._tucked.delete('music');
        this._sync();
    }

    _onTrack(p) {
        if (p?.meta.title && p.playing) {
            this._addHistory({icon: G.music, tint: 'white', title: plain(p.meta.title, 60),
                body: plain(p.meta.artist, 60)});
        }
    }

    _onNotification(n) {
        const a = {kind: 'notification', n, duration:
            n.urgency === MessageTray.Urgency.CRITICAL ? CRITICAL_MS : NOTIFICATION_MS};
        n.connectObject('destroy', () => {
            this._queue = this._queue.filter(q => q.n !== n);
            if (this._transient?.n === n)
                this._endTransient();
        }, this);
        this._addHistory({gicon: n.gicon ?? n.source?.icon, title: plain(n.title, 60), body: plain(n.body, 80)});
        // Replace an on-screen copy of the same notification (updates).
        if (this._transient?.n === n) {
            a.id = ++this._seq;
            this._transient = a;
            this._arm('transient', a.duration, () => this._endTransient());
            this._sync();
            return;
        }
        this.push(a);
    }

    _endTransient() {
        if (this._destroyed)
            return;
        this._clear('transient');
        // Hovering keeps it on screen until the pointer leaves.
        if (this.pill.hover && this._transient) {
            this._arm('transient', 800, () => this._endTransient());
            return;
        }
        this._transient = this._queue.shift() ?? null;
        if (this._transient)
            this._arm('transient', this._transient.duration ?? NOTIFICATION_MS, () => this._endTransient());
        this._sync();
    }

    _flashHudWhileExpanded(_a) {
        // The expanded island already shows what matters; skip the HUD.
    }

    _onHover() {
        if (this.pill.hover) {
            this._clear('hover-close');
            if (!this._expanded && this.settings.get_boolean('open-on-hover') && !this._transient) {
                this._arm('hover-open', this.settings.get_int('hover-delay'), () => {
                    if (this.pill.hover && !this._transient)
                        this._expand(true, true);
                });
            }
        } else {
            this._clear('hover-open');
            if (this._expanded && this._openedByHover)
                this._arm('hover-close', HOVER_CLOSE_MS, () => this._expand(false));
            if (this._revealed)
                this._arm('reveal', 1500, () => {
                    this._revealed = false;
                    this._sync();
                });
        }
    }

    _onClick(button) {
        this._clear('hover-open');
        const t = this._transient;
        if (button === 2) {
            this.mpris.active?.playPause();
            return Clutter.EVENT_STOP;
        }
        if (button === 3) {
            if (t?.kind === 'notification') {
                t.n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
                this._endTransient();
            } else if (this.timers.ringing) {
                this.timers.snoozeAlarm();
            } else if (t) {
                this._endTransient();
            }
            return Clutter.EVENT_STOP;
        }
        if (t?.kind === 'notification') {
            const n = t.n;
            this._transient = null;
            this._endTransient();
            n.activate();
            return Clutter.EVENT_STOP;
        }
        if (t) {
            this._transient = null;
            this._clear('transient');
            this._expand(true, false);
            return Clutter.EVENT_STOP;
        }
        if (!this._expanded && this.timers.ringing) {
            this.timers.stopAlarm();
            return Clutter.EVENT_STOP;
        }
        this._expand(!this._expanded, false);
        return Clutter.EVENT_STOP;
    }

    _onScroll(e) {
        let dir = 0;
        const d = e.get_scroll_direction();
        if (d === Clutter.ScrollDirection.DOWN)
            dir = 1;
        else if (d === Clutter.ScrollDirection.UP)
            dir = -1;
        else if (d === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = e.get_scroll_delta();
            this._scrollAcc = (this._scrollAcc ?? 0) + dy;
            if (Math.abs(this._scrollAcc) < 1)
                return Clutter.EVENT_STOP;
            dir = Math.sign(this._scrollAcc);
            this._scrollAcc = 0;
        }
        if (!dir)
            return Clutter.EVENT_STOP;
        // One flick is one step.
        const now = GLib.get_monotonic_time();
        if (now - (this._lastScroll ?? 0) < 280000)
            return Clutter.EVENT_STOP;
        this._lastScroll = now;

        if (!this._expanded) {
            if (this.settings.get_string('scroll-action') === 'volume') {
                const pct = this.system.nudgeVolume(-dir * 4);
                if (pct !== null) {
                    this.push({kind: 'hud', source: 'volume', icon: pct > 0 ? G.volHigh : G.volMute, tint: 'white',
                        percent: pct, value: `${pct}%`, duration: 1500});
                }
            } else if (dir > 0) {
                this._expand(true, false);
            }
            return Clutter.EVENT_STOP;
        }
        const pages = this.pages();
        const next = this._page + dir;
        if (next < 0) {
            this._expand(false);
        } else if (next < pages.length) {
            this._page = next;
            this._sync();
        }
        return Clutter.EVENT_STOP;
    }

    _expand(open, byHover = false, page = 0) {
        this._clear('hover-open');
        this._clear('hover-close');
        if (open && !this._expanded && this.settings.get_boolean('haptics'))
            this._tick();
        this._expanded = open;
        this._openedByHover = open && byHover;
        this._page = open ? Math.max(0, page) : 0;
        if (open)
            this._fastTicks(true);
        this._sync();
    }

    // Position and lyrics need a faster clock while the player is open.
    _fastTicks(on) {
        if (on && !this._fastTickId) {
            this._fastTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                if (!this._expanded && !this._live().length) {
                    this._fastTickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    // --- state -------------------------------------------------------------------

    // Running things, most important first: recording, alarm, timer, stopwatch, music.
    _live() {
        const l = [];
        if (this.system.recording)
            l.push({kind: 'recording'});
        if (this.timers.ringing)
            l.push({kind: 'alarm'});
        if (this.timers.timer)
            l.push({kind: 'timer'});
        if (this.timers.stopwatch)
            l.push({kind: 'stopwatch'});
        if (this.mpris.active?.playing)
            l.push({kind: 'music'});
        return l.filter(x => !this._tucked.has(x.kind));
    }

    _sync(force = false) {
        if (this._destroyed)
            return;
        const live = this._live();
        if (live.length)
            this._fastTicks(true);
        const pages = this.pages();
        this._page = Math.min(this._page, pages.length - 1);

        let mode, key, make;
        if (this._expanded) {
            const page = pages[this._page];
            mode = 'expanded';
            key = `expanded:${page}`;
            make = () => new ExpandedView(this, page);
        } else if (this._transient) {
            const t = this._transient;
            mode = t.kind;
            key = `${t.kind}:${t.kind === 'hud' ? t.source : t.id}`;
            if (t.kind === 'hud')
                make = () => new HudView(this, t);
            else if (t.kind === 'workspace')
                make = () => new WorkspaceView(this, t);
            else if (t.kind === 'notification')
                make = () => new NotificationView(this, t.n);
            else
                make = () => new AlertView(this, t);
        } else if (live.length) {
            mode = 'compact';
            key = `compact:${live[0].kind}`;
            make = () => new CompactView(this, live[0]);
        } else if (this.settings.get_boolean('show-when-idle') || this._revealed || this.pill.hover) {
            mode = 'idle';
            key = 'idle';
            make = () => new IdleView(this);
        } else {
            mode = 'hidden';
            key = 'hidden';
            make = null;
        }
        // In the overview the top bar is back; step aside.
        if (Main.overview.visible && (mode === 'idle' || mode === 'compact')) {
            mode = 'hidden';
            key = 'hidden';
            make = null;
        }

        if (key !== this._viewKey || force)
            this._swapView(key, make);
        this._mode = mode;

        let g = geometry(mode, this.idleWidth, this.idleHeight, this._view?.contentWidth ?? 0,
            this.settings.get_int('notification-width'));
        if (this.macbook)
            g = macbookShape(g, mode, mode === 'expanded' ? pages[this._page] : null);
        this._syncPanelClock();
        this._setTarget(g, mode);
        this._syncBubble(mode === 'compact' ? live[1] : null);
        this._syncMicDot(mode);
        this._edge.visible = mode === 'hidden' && !Main.overview.visible;
    }

    _swapView(key, make) {
        this._viewKey = key;
        const old = this._view;
        if (old) {
            const a = old.actor;
            a.ease({opacity: 0, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => a.destroy()});
        }
        this._view = make ? make() : null;
        if (!this._view)
            return;
        const a = this._view.actor;
        a.x_expand = a.y_expand = true;
        a.x_align = a.y_align = Clutter.ActorAlign.FILL;
        a.opacity = 0;
        a.set_pivot_point(0.5, 0.5);
        const reduce = this.settings.get_boolean('reduce-motion');
        if (!reduce)
            a.scale_x = a.scale_y = 0.94;
        this._stage.add_child(a);
        this._view.measure?.();
        a.ease({opacity: 255, scale_x: 1, scale_y: 1, delay: old ? 70 : 0, duration: reduce ? 160 : 260,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    _refresh() {
        if (this._destroyed)
            return;
        this._view?.update?.();
        // Live activities can end on their own (timer done, music paused).
        const liveKey = this._live().map(l => l.kind).join(',');
        if (liveKey !== this._liveKey) {
            this._liveKey = liveKey;
            this._sync();
        }
    }

    _setTarget(g, mode) {
        const reduce = this.settings.get_boolean('reduce-motion');
        const growing = g.w * g.h > this._w.value * this._h.value;
        const k = reduce ? 7 : growing ? 4.0 : 2.6;
        const d = reduce ? 1 : growing ? 0.36 : 0.33;
        this._w.to(g.w, {spring: k, damping: d});
        this._h.to(g.h, {spring: k * 1.08, damping: d});
        this._r.to(g.r, {spring: k, damping: reduce ? 1 : 0.5});
        this._target = g;
        this._targetMode = mode;
        this._driver.kick();
        // Content is laid out at its final size and revealed by the growing pill.
        this._stage.set_size(g.w, Math.max(1, g.h));
        this._applyGeometry();
    }

    // Which screen shows the island.
    _pickMonitor() {
        const lm = Main.layoutManager;
        const mode = this.settings.get_string('monitor');
        const builtin = () => {
            const mm = global.backend.get_monitor_manager();
            for (const c of ['eDP-1', 'eDP-2', 'LVDS-1', 'DSI-1']) {
                const i = mm.get_monitor_for_connector(c);
                if (i >= 0)
                    return lm.monitors[i];
            }
            return null;
        };
        if (mode === 'laptop')
            return builtin() ?? lm.primaryMonitor;
        if (mode === 'external') {
            const b = builtin();
            return lm.monitors.find(m => m !== b) ?? b ?? lm.primaryMonitor;
        }
        if (mode === 'focused') {
            const w = global.display.focus_window;
            const i = w ? w.get_monitor() : global.display.get_current_monitor();
            return lm.monitors[i] ?? lm.primaryMonitor;
        }
        return lm.primaryMonitor;
    }

    _followMonitor() {
        const mon = this._pickMonitor();
        if (mon === this._monitor)
            return;
        this._monitor = mon;
        this._applyGeometry();
    }

    _applyGeometry() {
        this._monitor ??= this._pickMonitor();
        const mon = this._monitor;
        if (!mon || this._destroyed)
            return;
        const inset = this.settings.get_int('pill-inset');
        const squish = 1 - 0.04 * Math.max(-1, Math.min(1, this._squish.value));
        const w = Math.max(1, Math.min(mon.width - 16, this._w.value * squish));
        const h = Math.max(0, Math.min(mon.height - 16, this._h.value * squish));
        const flat = this.macbook;
        const r = Math.max(0, Math.min(this._r.value, flat ? h : h / 2, w / 2));
        const x = Math.round(mon.x + (mon.width - w) / 2);
        const y = Math.round(mon.y + (flat ? 0 : inset));
        this.pill.set_position(x, y);
        this.pill.set_size(Math.round(w), Math.round(h));
        const hidden = this._targetMode === 'hidden';
        const opacity = hidden ? Math.round(255 * Math.min(1, h / Math.max(1, this.idleHeight))) : 255;
        this.pill.opacity = opacity;
        this.pill.visible = h > 0.5;
        const radius = Math.round(r);
        const shape = `${flat}|${radius}`;
        if (shape !== this._lastShape) {
            this._lastShape = shape;
            // Flat top: the island hangs from the top edge, only its bottom is rounded.
            this.pill.style = flat ? `border-radius: 0 0 ${radius}px ${radius}px;` : `border-radius: ${radius}px;`;
        }
        const tw = this._target?.w ?? w;
        this._stage.set_position(Math.round((w - tw) / 2), 0);

        // Mic dot sits at the right end of the pill.
        this._micDot.set_position(Math.round(w - Math.max(12, h * 0.42)), Math.round(h / 2 - 3));

        // Bubble: starts behind the island and springs out to the right.
        const s = this._split.value;
        const bh = this.idleHeight;
        const bx = x + w + (BUBBLE_GAP + bh) * s - bh;
        this.bubble.set_size(bh, bh);
        this.bubble.set_position(Math.round(bx), y);
        const br = Math.ceil(bh / 2);
        this.bubble.style = flat ? `border-radius: 0 0 ${br}px ${br}px;` : `border-radius: ${br}px;`;
        this.bubble.opacity = Math.round(255 * Math.max(0, Math.min(1, s)));
        this.bubble.visible = s > 0.02;

        this._edge.set_position(Math.round(mon.x + (mon.width - this._edge.width) / 2), mon.y);
    }

    _syncBubble(second) {
        if (second) {
            const [g, tint] = liveGlyph(second.kind);
            this._bubbleGlyph.text = g;
            this._bubbleGlyph.style = `font-size: 15px; color: ${tint === 'white' ? (this.media.tint || '#fff') : tint === 'red' ? '#FF453A' : '#FF9F0A'};`;
        }
        this._split.to(second ? 1 : 0);
        this._driver.kick();
    }

    _syncMicDot(mode) {
        this._micDot.visible = this.settings.get_boolean('show-mic-indicator') && this.system.micInUse &&
            (mode === 'idle' || mode === 'compact');
    }

    // --- helpers -----------------------------------------------------------------

    _addHistory(item) {
        this.history.unshift({...item, time: GLib.DateTime.new_now_local()});
        if (this.history.length > HISTORY_MAX)
            this.history.length = HISTORY_MAX;
    }

    _arm(name, ms, fn) {
        this._clear(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
            this._timeouts.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(name, id);
    }

    _clear(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }

    _tick() {
        try {
            const f = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'sounds', 'tick.wav']));
            global.display.get_sound_player().play_from_file(f, 'Dynamic Island', null);
        } catch {}
    }

    _playTheme(name) {
        try {
            global.display.get_sound_player().play_from_theme(name, 'Dynamic Island', null);
        } catch {}
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._timeouts.values())
            GLib.source_remove(id);
        this._timeouts.clear();
        if (this._tickId)
            GLib.source_remove(this._tickId);
        if (this._fastTickId)
            GLib.source_remove(this._fastTickId);
        for (const [obj, id] of this._signals) {
            try {
                obj.disconnect(id);
            } catch {}
        }
        this._signals = [];
        Main.wm.removeKeybinding('toggle-shortcut');
        if (this._clockHidden)
            Main.panel.statusArea.dateMenu?.container.show();
        this._driver.destroy();
        for (const a of [this.pill, this.bubble, this._edge]) {
            Main.layoutManager.removeChrome(a);
            a.destroy();
        }
    }
}
