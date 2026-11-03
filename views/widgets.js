// Small building blocks shared by the island's views.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';

import {C} from '../lib/model.js';

export const TYPE = {caption2: 10, caption: 11, footnote: 12, subhead: 13, callout: 15, body: 17,
    title3: 20, title2: 22, title1: 26, large: 34, hero: 46};

export function color(tint) {
    return C[tint] ?? tint ?? C.white;
}

export function label(text, {size = TYPE.subhead, weight = 400, tint = 'white', display = false,
    ellipsize = true, x_expand = false, align = 'left', mono = false, style = ''} = {}) {
    const family = display ? "Inter Island Display" : "Inter Island";
    const l = new St.Label({
        text: String(text ?? ''),
        style_class: 'di-text',
        x_expand,
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-family: "${family}"; font-size: ${size}px; ` +
            `font-weight: ${weight}; color: ${color(tint)}; text-align: ${align};` +
            `${mono ? 'font-feature-settings: "tnum";' : ''}${style}`,
    });
    l.clutter_text.ellipsize = ellipsize ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE;
    return l;
}

export function setTint(actor, tint, size, family) {
    actor.style = `font-family: "${family}"; font-size: ${size}px; color: ${color(tint)};`;
}

export function glyph(g, {size = 18, tint = 'white'} = {}) {
    const l = new St.Label({
        text: g,
        style_class: 'di-glyph',
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
    l._size = size;
    l.style = `font-size: ${size}px; color: ${color(tint)};`;
    return l;
}

export function setGlyphTint(l, tint) {
    l.style = `font-size: ${l._size}px; color: ${color(tint)};`;
}

// Round icon button. onClick receives the mouse button number.
export function button(g, onClick, {size = 18, pad = 8, tint = 'white', bg = false, accessible = ''} = {}) {
    const child = glyph(g, {size, tint});
    const b = new St.Button({
        child,
        style_class: bg ? 'di-btn di-btn-bg' : 'di-btn',
        style: `padding: ${pad}px;`,
        can_focus: true,
        reactive: true,
        accessible_name: accessible,
        y_align: Clutter.ActorAlign.CENTER,
        button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
    });
    b.connect('clicked', (_b, btn) => onClick(btn));
    b.glyph = child;
    return b;
}

// Text pill button ("5m", "Stop", ...).
export function pillButton(text, onClick, {tint = 'white', bg = 'rgba(255,255,255,0.12)', size = TYPE.footnote} = {}) {
    const b = new St.Button({
        child: label(text, {size, weight: 600, tint, ellipsize: false}),
        style_class: 'di-pill-btn',
        style: `background-color: ${bg};`,
        reactive: true,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    b.connect('clicked', () => onClick());
    return b;
}

// Rounded album art; falls back to a music glyph on a dark square.
export class Artwork {
    constructor(size, radius, fallbackGlyph) {
        this.actor = new St.Widget({
            style_class: 'di-art',
            width: size,
            height: size,
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._size = size;
        this._radius = radius;
        this._fallback = glyph(fallbackGlyph, {size: Math.round(size * 0.5), tint: 'secondary'});
        this.actor.add_child(this._fallback);
        this.set('');
    }

    set(path) {
        if (path === this._path)
            return;
        this._path = path;
        const url = path ? `file://${path}` : '';
        this._fallback.visible = !path;
        this.actor.style = `border-radius: ${this._radius}px;` +
            (path
                ? `background-image: url("${url}"); background-size: cover;`
                : 'background-color: rgba(255,255,255,0.10);');
    }
}

// Spectrum bars. Driven by cava values (0..1) when available, else by a
// soft made-up dance while playing.
export class Waveform {
    constructor(bars = 6, {width = 3, gap = 2, height = 16, tint = '#FFFFFF'} = {}) {
        this.actor = new St.BoxLayout({style: `spacing: ${gap}px;`, y_align: Clutter.ActorAlign.CENTER});
        this._h = height;
        this._bars = [];
        this._tint = tint;
        for (let i = 0; i < bars; i++) {
            const b = new St.Widget({width, height: 3, y_align: Clutter.ActorAlign.CENTER,
                style: `background-color: ${tint}; border-radius: ${width}px;`});
            this.actor.add_child(b);
            this._bars.push(b);
        }
        this._phase = Math.random() * 10;
        this._danceId = 0;
        this.actor.connect('destroy', () => this._stopDance());
    }

    setTint(tint) {
        if (tint === this._tint)
            return;
        this._tint = tint;
        const w = this._bars[0]?.width ?? 3;
        this._bars.forEach(b => (b.style = `background-color: ${tint}; border-radius: ${w}px;`));
    }

    setLevels(levels) {
        const n = this._bars.length;
        this._bars.forEach((b, i) => {
            const src = levels.length ? levels[Math.floor(i * levels.length / n)] : 0;
            b.height = Math.max(3, Math.round(3 + (this._h - 3) * Math.min(1, src)));
        });
    }

    // playing && no spectrum -> dance; spectrum -> real values; paused -> flat.
    update(playing, spectrum) {
        if (playing && spectrum?.length) {
            this._stopDance();
            this.setLevels(spectrum);
        } else if (playing) {
            this._startDance();
        } else {
            this._stopDance();
            this.setLevels([]);
        }
    }

    _startDance() {
        if (this._danceId)
            return;
        this._danceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
            this._phase += 0.42;
            const n = this._bars.length;
            const levels = this._bars.map((_b, i) =>
                0.25 + 0.75 * Math.abs(Math.sin(this._phase * (1 + i * 0.37) + i * 1.3)) *
                (0.55 + 0.45 * Math.sin(this._phase * 0.5 + i / n * Math.PI)));
            this.setLevels(levels);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopDance() {
        if (this._danceId)
            GLib.source_remove(this._danceId);
        this._danceId = 0;
    }
}

// Thin track with a fill; optional seek on click.
export class LevelBar {
    constructor({width = 140, height = 6, tint = '#FFFFFF', onSeek = null} = {}) {
        this.actor = new St.Widget({
            width, height,
            reactive: !!onSeek,
            track_hover: !!onSeek,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: `background-color: rgba(255,255,255,0.22); border-radius: ${height}px;`,
        });
        this._fill = new St.Widget({height, style: `background-color: ${tint}; border-radius: ${height}px;`});
        this.actor.add_child(this._fill);
        this._height = height;
        this._tint = tint;
        this._fraction = 0;
        this.actor.connect('notify::width', () => this._layout());
        if (onSeek) {
            this.actor.connect('button-release-event', (a, event) => {
                const [x] = event.get_coords();
                const [ax] = a.get_transformed_position();
                onSeek(Math.max(0, Math.min(1, (x - ax) / Math.max(1, a.width))));
                return Clutter.EVENT_STOP;
            });
            // Thicken under the pointer to show it can be scrubbed.
            this.actor.connect('notify::hover', () => {
                const h = this.actor.hover ? this._height + 4 : this._height;
                this.actor.ease({scale_y: h / this._height, duration: 140,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            });
            this.actor.set_pivot_point(0.5, 0.5);
        }
    }

    setTint(tint) {
        if (tint === this._tint)
            return;
        this._tint = tint;
        this._fill.style = `background-color: ${tint}; border-radius: ${this._height}px;`;
    }

    set(fraction) {
        this._fraction = Math.max(0, Math.min(1, fraction || 0));
        this._layout();
    }

    _layout() {
        const w = this.actor.width;
        this._fill.width = Math.max(this._fraction > 0 ? this._height : 0, Math.round(w * this._fraction));
    }
}
