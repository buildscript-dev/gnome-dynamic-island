// What the island shows in each mode. Every view has `actor`, an optional
// `contentWidth` (for modes that size to their content) and update().

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';

import {G, C, formatTime, plain, lyricAt} from '../lib/model.js';
import {TYPE, label, glyph, setGlyphTint, button, pillButton, Artwork, Waveform, LevelBar, color} from './widgets.js';

const ROW = (spacing = 8, extra = {}) =>
    new St.BoxLayout({style: `spacing: ${spacing}px;`, y_align: Clutter.ActorAlign.CENTER, ...extra});
const COL = (spacing = 2, extra = {}) =>
    new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: `spacing: ${spacing}px;`,
        y_align: Clutter.ActorAlign.CENTER, ...extra});
const SPACER = () => new St.Widget({x_expand: true});

function textWidth(actor) {
    return Math.ceil(actor.get_preferred_width(-1)[1]);
}

// --- idle ---------------------------------------------------------------------

export class IdleView {
    constructor(ctx) {
        this.ctx = ctx;
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._clock = label('', {size: TYPE.footnote, weight: 600, ellipsize: false, mono: true});
        this._clock.x_align = Clutter.ActorAlign.CENTER;
        this.actor.add_child(this._clock);
        this.update();
    }

    update() {
        const s = this.ctx.settings;
        this._clock.visible = s.get_boolean('show-clock');
        const t = GLib.DateTime.new_now_local().format(s.get_string('clock-format')) ?? '';
        if (this._clock.text !== t.trim())
            this._clock.text = t.trim();
    }
}

// --- compact live activity ----------------------------------------------------

// Leading and trailing views hug the ends in equal slots, leaving the
// middle clear like the space around the iPhone's camera.
export class CompactView {
    constructor(ctx, live) {
        this.ctx = ctx;
        this.live = live;
        const h = ctx.idleHeight;
        this.actor = new St.BoxLayout({style: `padding: 0 ${Math.round(h * 0.3)}px;`});
        this._lead = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._trail = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.actor.add_child(this._lead);
        this.actor.add_child(SPACER());
        this.actor.add_child(this._trail);

        const k = live.kind;
        if (k === 'music') {
            this._art = new Artwork(h - 10, 6, G.music);
            this._lead.add_child(this._art.actor);
            this._wave = new Waveform(5, {width: 3, gap: 2, height: h - 14});
            this._trail.add_child(this._wave.actor);
        } else {
            const spec = {
                timer: [G.timer, 'orange'],
                stopwatch: [G.stopwatch, 'orange'],
                recording: [G.record, 'red'],
                alarm: [G.alarm, 'orange'],
            }[k] ?? [G.bell, 'white'];
            this._icon = glyph(spec[0], {size: 16, tint: spec[1]});
            this._lead.add_child(this._icon);
            this._text = label('', {size: TYPE.subhead, weight: 600, tint: spec[1], ellipsize: false, mono: true});
            this._trail.add_child(this._text);
        }
        this.update();
    }

    // Called once the view is on the stage, so text can be measured.
    measure() {
        const h = this.ctx.idleHeight;
        // Equal slots: both ends as wide as the wider one.
        const slot = Math.max(this._lead.get_preferred_width(-1)[1], this.live.kind === 'music' ? 0 : 52,
            this._trail.get_preferred_width(-1)[1]);
        this._lead.width = slot;
        this._trail.width = slot;
        this._text?.set_x_align(Clutter.ActorAlign.END);
        this.contentWidth = Math.round(slot * 2 + h * 0.6 + this.ctx.idleWidth * 0.62);
    }

    update() {
        const ctx = this.ctx;
        switch (this.live.kind) {
        case 'music': {
            const p = ctx.mpris.active;
            this._art.set(ctx.media.artPath);
            this._wave.setTint(ctx.settings.get_boolean('artwork-tint') ? ctx.media.tint : C.white);
            this._wave.update(!!p?.playing, ctx.media.spectrum);
            break;
        }
        case 'timer':
            this._text.text = formatTime(Math.ceil(ctx.timers.timerLeft));
            break;
        case 'stopwatch':
            this._text.text = formatTime(ctx.timers.stopwatchElapsed);
            break;
        case 'recording': {
            this._text.text = formatTime((GLib.get_monotonic_time() - ctx.system.recordingStart) / 1e6);
            const on = Math.floor(GLib.get_monotonic_time() / 600000) % 2 === 0;
            this._icon.ease({opacity: on ? 255 : 90, duration: 500, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
            break;
        }
        case 'alarm':
            this._text.text = 'Alarm';
            break;
        }
    }
}

// Glyph shown in the detached bubble for a second live activity.
export function liveGlyph(kind) {
    return {
        music: [G.music, 'white'],
        timer: [G.timer, 'orange'],
        stopwatch: [G.stopwatch, 'orange'],
        recording: [G.record, 'red'],
        alarm: [G.alarm, 'orange'],
    }[kind] ?? [G.bell, 'white'];
}

// --- HUD (volume, brightness, keyboard) -----------------------------------------

export class HudView {
    constructor(ctx, a) {
        this.ctx = ctx;
        const h = ctx.idleHeight + 12;
        this.actor = ROW(12, {style: `spacing: 12px; padding: 0 ${Math.round(h * 0.42)}px;`});
        this._icon = glyph(a.icon, {size: 18, tint: a.tint});
        this._bar = new LevelBar({width: 120, height: 6, tint: color(a.tint)});
        this._value = label('', {size: TYPE.footnote, weight: 600, ellipsize: false, mono: true,
            tint: 'white', align: 'right'});
        this._value.width = 30;
        this.actor.add_child(this._icon);
        this.actor.add_child(this._bar.actor);
        this.actor.add_child(this._value);
        this.set(a);
    }

    // Holding the volume key updates the HUD in place.
    set(a) {
        this.a = a;
        this._icon.text = a.icon;
        setGlyphTint(this._icon, a.tint);
        this._bar.setTint(color(a.source === 'volume' && a.percent > 100 ? 'orange' : a.tint));
        this._bar.set(a.percent / 100);
        this._value.text = String(a.percent);
    }

    update() {}
}

// --- alert pill -------------------------------------------------------------------

export class AlertView {
    constructor(ctx, a) {
        this.ctx = ctx;
        const h = ctx.idleHeight + 8;
        this.actor = ROW(10, {style: `spacing: 10px; padding: 0 ${Math.round(h * 0.28)}px;`});
        const badge = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: h - 10, height: h - 10,
            style: `border-radius: ${h}px; background-color: ${color(a.tint)}33;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const g = glyph(a.icon, {size: 15, tint: a.tint});
        badge.add_child(g);
        this.actor.add_child(badge);
        const title = label(a.title, {size: TYPE.subhead, weight: 600, x_expand: true});
        this.actor.add_child(title);
        if (a.value) {
            const v = label(a.value, {size: TYPE.subhead, weight: 600, tint: a.tint === 'white' ? 'secondary' : a.tint,
                ellipsize: false, mono: true});
            this.actor.add_child(v);
        }
        this._pad = Math.round(h * 0.28);
        // Pop the glyph in with a spring each time the card shows.
        g.set_pivot_point(0.5, 0.5);
        g.scale_x = g.scale_y = 0.5;
        g.ease({scale_x: 1, scale_y: 1, duration: 420, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    measure() {
        this.contentWidth = Math.min(460, textWidth(this.actor) + this._pad * 2 + 12);
    }

    update() {}
}

// --- notification peek --------------------------------------------------------------

export class NotificationView {
    constructor(ctx, n) {
        this.ctx = ctx;
        this.n = n;
        this.actor = ROW(12, {style: 'spacing: 12px; padding: 12px 18px 12px 14px;'});
        const gicon = n.gicon ?? n.source?.icon ?? null;
        const icon = new St.Icon({gicon, icon_size: 36, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'di-notif-icon', fallback_icon_name: 'dialog-information-symbolic'});
        this.actor.add_child(icon);
        const col = COL(2, {x_expand: true});
        const head = ROW(6);
        head.add_child(label(plain(n.title, 80), {size: TYPE.subhead, weight: 600, x_expand: true}));
        head.add_child(label(plain(n.source?.title ?? '', 30), {size: TYPE.caption, tint: 'secondary', ellipsize: false}));
        col.add_child(head);
        const body = label(plain(n.body, 240), {size: TYPE.footnote, tint: 'secondary'});
        body.clutter_text.line_wrap = true;
        body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(body);
        this.actor.add_child(col);
    }

    update() {}
}

// --- expanded ---------------------------------------------------------------------

export class ExpandedView {
    constructor(ctx, page) {
        this.ctx = ctx;
        this.page = page;
        this.actor = new St.BoxLayout({x_expand: true, y_expand: true});
        const body = {player: PlayerPage, home: HomePage, history: HistoryPage}[page] ?? HomePage;
        this._page = new body(ctx);
        this._page.actor.x_expand = true;
        this.actor.add_child(this._page.actor);

        // Page dots on the right edge.
        const pages = ctx.pages();
        if (pages.length > 1) {
            const dots = COL(5, {y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 5px; padding-right: 12px;'});
            for (const p of pages) {
                dots.add_child(new St.Widget({width: 5, height: 5,
                    style: `border-radius: 5px; background-color: ${p === page ? '#FFFFFF' : 'rgba(255,255,255,0.28)'};`}));
            }
            this.actor.add_child(dots);
        }
        this.update();
    }

    update() {
        this._page.update();
    }
}

class PlayerPage {
    constructor(ctx) {
        this.ctx = ctx;
        this.actor = ROW(16, {style: 'spacing: 16px; padding: 20px 30px 18px 22px;', x_expand: true, y_expand: true});
        this._art = new Artwork(92, 18, G.music);
        this._art.actor.reactive = true;
        this._art.actor.connect('button-release-event', () => {
            ctx.mpris.active?.raise();
            return Clutter.EVENT_STOP;
        });
        this.actor.add_child(this._art.actor);

        const col = COL(4, {x_expand: true, y_expand: true});
        const top = ROW(8);
        const titles = COL(1, {x_expand: true});
        this._title = label('', {size: TYPE.body, weight: 600});
        this._artist = label('', {size: TYPE.subhead, tint: 'secondary'});
        titles.add_child(this._title);
        titles.add_child(this._artist);
        top.add_child(titles);
        this._wave = new Waveform(6, {width: 3, gap: 2, height: 20});
        top.add_child(this._wave.actor);
        col.add_child(top);

        this._lyric = label('', {size: TYPE.footnote, weight: 500});
        col.add_child(this._lyric);

        const scrub = ROW(8);
        this._elapsed = label('0:00', {size: TYPE.caption, tint: 'secondary', ellipsize: false, mono: true});
        this._remain = label('-0:00', {size: TYPE.caption, tint: 'secondary', ellipsize: false, mono: true});
        this._bar = new LevelBar({width: 200, height: 5, onSeek: f => {
            const p = ctx.mpris.active;
            if (p?.canSeek)
                p.seekTo(f * p.meta.length);
        }});
        scrub.add_child(this._elapsed);
        scrub.add_child(this._bar.actor);
        scrub.add_child(this._remain);
        col.add_child(scrub);

        const controls = ROW(18, {x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 18px;'});
        controls.add_child(button(G.prev, () => ctx.mpris.active?.previous(), {size: 22, accessible: 'Previous'}));
        this._play = button(G.play, () => ctx.mpris.active?.playPause(), {size: 30, accessible: 'Play or pause'});
        controls.add_child(this._play);
        controls.add_child(button(G.next, () => ctx.mpris.active?.next(), {size: 22, accessible: 'Next'}));
        col.add_child(controls);
        this.actor.add_child(col);
    }

    update() {
        const {mpris, media, settings} = this.ctx;
        const p = mpris.active;
        if (!p)
            return;
        const m = p.meta;
        this._art.set(media.artPath);
        if (this._title.text !== m.title)
            this._title.text = m.title;
        const sub = [m.artist, m.album].filter(Boolean).join(' — ');
        if (this._artist.text !== sub)
            this._artist.text = sub;
        const tint = settings.get_boolean('artwork-tint') ? media.tint : C.white;
        this._wave.setTint(tint);
        this._wave.update(p.playing, media.spectrum);
        this._bar.setTint(tint);
        const pos = p.position, len = m.length;
        this._bar.set(len > 0 ? pos / len : 0);
        this._elapsed.text = formatTime(pos);
        this._remain.text = len > 0 ? `-${formatTime(len - pos)}` : '';
        this._play.glyph.text = p.playing ? G.pause : G.play;
        const line = (media.lyrics.length ? lyricAt(media.lyrics, pos) : '') || ' ';
        if (this._lyric.text !== line) {
            this._lyric.text = line;
            this._lyric.style = this._lyric.style.replace(/color: [^;]+;/, `color: ${tint};`);
            this._lyric.opacity = 0;
            this._lyric.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }
}

class HomePage {
    constructor(ctx) {
        this.ctx = ctx;
        this.actor = ROW(22, {style: 'spacing: 22px; padding: 18px 30px 18px 26px;', x_expand: true, y_expand: true});

        // Left: clock, date and this week.
        const left = COL(4, {y_align: Clutter.ActorAlign.CENTER});
        this._clock = label('', {size: TYPE.large, weight: 700, display: true, ellipsize: false, mono: true});
        this._date = label('', {size: TYPE.footnote, tint: 'secondary', ellipsize: false});
        left.add_child(this._clock);
        left.add_child(this._date);
        this._week = ROW(4, {style: 'spacing: 4px; padding-top: 6px;'});
        left.add_child(this._week);
        this.actor.add_child(left);
        this._buildWeek();

        // Right: timers, stopwatch, focus, recording.
        this._right = COL(10, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._right);

        this._timerRow = ROW(6);
        this._stopwatchRow = ROW(6);
        this._miscRow = ROW(6);
        this._right.add_child(this._timerRow);
        this._right.add_child(this._stopwatchRow);
        this._right.add_child(this._miscRow);
        this._sig = '';
        this.update();
    }

    _buildWeek() {
        const now = GLib.DateTime.new_now_local();
        const dow = now.get_day_of_week() % 7; // Sunday = 0
        const sunday = now.add_days(-dow);
        for (let i = 0; i < 7; i++) {
            const d = sunday.add_days(i);
            const today = i === dow;
            const cell = COL(1, {style: 'spacing: 1px;'});
            const name = label(d.format('%a').slice(0, 1), {size: TYPE.caption2, tint: today ? 'orange' : 'secondary',
                weight: 600, ellipsize: false, align: 'center'});
            name.x_align = Clutter.ActorAlign.CENTER;
            const num = new St.Widget({layout_manager: new Clutter.BinLayout(), width: 22, height: 22,
                style: today ? `border-radius: 22px; background-color: ${C.orange};` : ''});
            const n = label(String(d.get_day_of_month()), {size: TYPE.caption, weight: today ? 700 : 500,
                tint: today ? '#000000' : 'white', ellipsize: false});
            n.x_align = Clutter.ActorAlign.CENTER;
            num.add_child(n);
            cell.add_child(name);
            cell.add_child(num);
            this._week.add_child(cell);
        }
    }

    // Rebuild the right column only when its shape changes.
    _signature() {
        const {timers, system} = this.ctx;
        return [!!timers.timer, timers.timer?.paused, !!timers.stopwatch, timers.stopwatch?.running,
            !!timers.alarm, timers.ringing, system.dnd, system.recording].join(',');
    }

    _rebuild() {
        const {timers, system} = this.ctx;
        [this._timerRow, this._stopwatchRow, this._miscRow].forEach(r => r.destroy_all_children());
        this._timerText = this._swText = null;

        if (timers.timer) {
            this._timerRow.add_child(glyph(G.timer, {size: 16, tint: 'orange'}));
            this._timerText = label('', {size: TYPE.title3, weight: 600, tint: 'orange', ellipsize: false, mono: true,
                x_expand: true});
            this._timerRow.add_child(this._timerText);
            this._timerRow.add_child(button(timers.timer.paused ? G.play : G.pause, () => timers.toggleTimer(),
                {size: 14, pad: 7, bg: true, tint: 'orange'}));
            this._timerRow.add_child(button(G.cross, () => timers.cancelTimer(), {size: 14, pad: 7, bg: true}));
        } else {
            this._timerRow.add_child(glyph(G.timer, {size: 16, tint: 'orange'}));
            for (const m of [1, 5, 10, 25])
                this._timerRow.add_child(pillButton(`${m}m`, () => timers.startTimer(m * 60), {tint: 'orange'}));
        }

        this._stopwatchRow.add_child(glyph(G.stopwatch, {size: 16, tint: 'orange'}));
        this._swText = label('', {size: TYPE.callout, weight: 600, ellipsize: false, mono: true, x_expand: true});
        this._stopwatchRow.add_child(this._swText);
        this._stopwatchRow.add_child(button(timers.stopwatch?.running ? G.pause : G.play,
            () => timers.toggleStopwatch(), {size: 14, pad: 7, bg: true}));
        if (timers.stopwatch)
            this._stopwatchRow.add_child(button(G.cross, () => timers.resetStopwatch(), {size: 14, pad: 7, bg: true}));

        this._miscRow.add_child(pillButton(system.dnd ? 'Focus On' : 'Focus', () => (system.dnd = !system.dnd),
            {tint: system.dnd ? 'indigo' : 'white', bg: system.dnd ? `${C.indigo}33` : 'rgba(255,255,255,0.12)'}));
        if (system.recording) {
            this._miscRow.add_child(pillButton('Stop Recording', () => system.stopRecording(),
                {tint: 'red', bg: `${C.red}33`}));
        }
        if (timers.ringing) {
            this._miscRow.add_child(pillButton('Stop Alarm', () => timers.stopAlarm(), {tint: 'orange', bg: `${C.orange}33`}));
            this._miscRow.add_child(pillButton('Snooze', () => timers.snoozeAlarm()));
        } else if (timers.alarm) {
            const a = timers.alarm;
            this._miscRow.add_child(pillButton(`${G.alarm} ${a.hh}:${String(a.mm).padStart(2, '0')}  ✕`,
                () => timers.cancelAlarm(), {tint: 'orange'}));
        }
    }

    update() {
        const {timers, settings} = this.ctx;
        const now = GLib.DateTime.new_now_local();
        this._clock.text = (now.format(settings.get_string('clock-format')) ?? '').trim();
        this._date.text = now.format('%A, %e %B').replace(/\s+/g, ' ');
        const sig = this._signature();
        if (sig !== this._sig) {
            this._sig = sig;
            this._rebuild();
        }
        if (this._timerText)
            this._timerText.text = formatTime(Math.ceil(timers.timerLeft));
        if (this._swText)
            this._swText.text = timers.stopwatch ? formatTime(timers.stopwatchElapsed) : 'Stopwatch';
    }
}

class HistoryPage {
    constructor(ctx) {
        this.ctx = ctx;
        this.actor = COL(8, {style: 'spacing: 8px; padding: 16px 30px 16px 24px;', x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.START});
        const head = ROW(8);
        head.add_child(label('History', {size: TYPE.callout, weight: 700, x_expand: true}));
        head.add_child(pillButton('Clear', () => {
            ctx.history.length = 0;
            this._fill();
        }));
        this.actor.add_child(head);
        this._list = COL(6, {style: 'spacing: 6px;'});
        this.actor.add_child(this._list);
        this._fill();
    }

    _fill() {
        this._list.destroy_all_children();
        const items = this.ctx.history.slice(0, 4);
        if (!items.length) {
            this._list.add_child(label('Nothing yet', {size: TYPE.footnote, tint: 'secondary'}));
            return;
        }
        for (const it of items) {
            const row = ROW(10, {style: 'spacing: 10px; padding: 5px 10px; border-radius: 12px; background-color: rgba(255,255,255,0.07);'});
            if (it.gicon) {
                row.add_child(new St.Icon({gicon: it.gicon, icon_size: 18, y_align: Clutter.ActorAlign.CENTER}));
            } else {
                row.add_child(glyph(it.icon ?? G.bell, {size: 15, tint: it.tint ?? 'white'}));
            }
            row.add_child(label(it.title, {size: TYPE.footnote, weight: 600}));
            row.add_child(label(it.body ?? '', {size: TYPE.footnote, tint: 'secondary', x_expand: true}));
            row.add_child(label(it.time.format('%H:%M'), {size: TYPE.caption, tint: 'secondary', ellipsize: false}));
            this._list.add_child(row);
        }
    }

    update() {}
}
