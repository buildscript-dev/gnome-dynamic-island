// Pure helpers shared by the island: glyphs, colors, geometry per mode and
// text formatting. Ported from omarchy-dynamic-island's IslandModel.js.

const glyph = cp => String.fromCodePoint(cp);

// Phosphor Fill glyphs (MIT, bundled in fonts/).
export const G = {
    volHigh: glyph(0xE44A),
    volMed: glyph(0xE44C),
    volLow: glyph(0xE44E),
    volMute: glyph(0xE45C),
    brightLow: glyph(0xE474),
    brightHigh: glyph(0xE472),
    play: glyph(0xE3D0),
    pause: glyph(0xE39E),
    next: glyph(0xE5A6),
    prev: glyph(0xE5A4),
    battery: glyph(0xE0C0),
    charging: glyph(0xE0BA),
    batteryAlert: glyph(0xE0C8),
    bluetooth: glyph(0xE0DA),
    headphones: glyph(0xE2A6),
    moon: glyph(0xE330),
    sun: glyph(0xE472),
    timer: glyph(0xED2C),
    stopwatch: glyph(0xE492),
    alarm: glyph(0xE006),
    bell: glyph(0xE0CE),
    bellOff: glyph(0xE0D4),
    music: glyph(0xE33C),
    mic: glyph(0xE326),
    micOff: glyph(0xE328),
    keyboard: glyph(0xE2D8),
    record: glyph(0xE3EE),
    wifi: glyph(0xE4EA),
    power: glyph(0xE3DA),
    check: glyph(0xE182),
    cross: glyph(0xE4F6),
    wifiOff: glyph(0xE4F2),
    bluetoothOff: glyph(0xE0DE),
    gear: glyph(0xE272),
    lock: glyph(0xE2FA),
    camera: glyph(0xE10E),
    coffee: glyph(0xE1C2),
    lightning: glyph(0xE2DE),
    leaf: glyph(0xE2DA),
    gauge: glyph(0xE628),
    phone: glyph(0xE1E0),
    halfMoon: glyph(0xE18C),
    moonStars: glyph(0xE58E),
    monitor: glyph(0xE32E),
    textAa: glyph(0xE6EE),
};

// Sink descriptions are driver strings; show what a person would call them.
export function friendlyOutput(d) {
    const n = String(d).toLowerCase();
    if (n.includes('sunshine'))
        return 'Stream (Sunshine)';
    if (n.includes('hdmi')) {
        const m = /\[([^\]]+)\]/.exec(d);
        return m ? m[1] : 'HDMI Display';
    }
    if (n.includes('analog') || n.includes('speaker') || n.includes('built-in'))
        return 'Laptop Speakers';
    if (n.includes('vw experience') || n.includes('chaser'))
        return 'VW Chaser Bar';
    if (n.includes('easy effects'))
        return 'Equalised Sound';
    return d;
}

export const PROFILES = {
    'performance': {name: 'Performance', glyph: G.lightning, tint: 'orange'},
    'balanced': {name: 'Balanced', glyph: G.gauge, tint: 'white'},
    'power-saver': {name: 'Power Saver', glyph: G.leaf, tint: 'green'},
};

// Apple's system colors (dark appearance).
export const C = {
    green: '#30D158',
    red: '#FF453A',
    orange: '#FF9F0A',
    yellow: '#FFD60A',
    blue: '#0A84FF',
    indigo: '#5E5CE6',
    purple: '#BF5AF2',
    pink: '#FF375F',
    white: '#FFFFFF',
    secondary: '#98989F',
};

export function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

export function volumeGlyph(percent, muted) {
    if (muted || percent <= 0)
        return G.volMute;
    if (percent < 34)
        return G.volLow;
    if (percent < 67)
        return G.volMed;
    return G.volHigh;
}

export function batteryGlyph(percent, charging) {
    if (charging)
        return G.charging;
    if (percent <= 15)
        return G.batteryAlert;
    return G.battery;
}

// Size of the island body per mode. w/h are the idle bubble size.
export function geometry(mode, w, h, contentWidth = 0, notifWidth = 360) {
    const round = Math.ceil(h / 2);
    switch (mode) {
    case 'compact':
        return {w: Math.max(contentWidth, w + (h - 2) * 2), h, r: round};
    case 'alert': {
        const ah = h + 8;
        return {w: clamp(contentWidth, w + (h - 2) * 2, 460), h: ah, r: Math.ceil(ah / 2)};
    }
    case 'hud': {
        const hh = h + 12;
        return {w: w + 160, h: hh, r: Math.ceil(hh / 2)};
    }
    case 'notification':
        return {w: notifWidth, h: h + 52, r: 24};
    case 'expanded':
        return {w: Math.max(w + 440, 560), h: h + 172, r: 34};
    case 'hidden':
        return {w, h: 0, r: 0};
    default:
        return {w: Math.max(w, contentWidth), h, r: round};
    }
}

// MacBook style, measured from Apple's MacBook Pro PROLED XDR product stills
// (see docs/macbook-measurements.md): the island hangs from the top edge with
// a flat top, bottom corners of ~0.155 x its height, and expanded cards about
// 1.6 x as wide as they are tall.
export const MACBOOK = {cornerRatio: 0.155, cardRatio: 1.6, minCorner: 14, smallCorner: 0.4};

export function macbookShape(g, mode, page) {
    const out = {...g, flat: true};
    if (mode === 'expanded' && page === 'player') {
        out.h = 272;
        out.w = Math.round(out.h * MACBOOK.cardRatio);
    }
    out.r = Math.round(Math.max(out.h * MACBOOK.cornerRatio, Math.min(out.h * MACBOOK.smallCorner, MACBOOK.minCorner)));
    return out;
}

export function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// Strip Pango/HTML markup and collapse whitespace; cap the length.
export function plain(text, max = 200) {
    let t = String(text ?? '').replace(/<[^>]*>/g, '');
    t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Lift a dull album color so it reads on black: keep its hue, push
// saturation and lightness into a range that glows.
export function vividColor(r, g, b) {
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
    let hue = 0;
    const l = (max + min) / 2;
    const d = max - min;
    let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
        const rr = r / 255, gg = g / 255, bb = b / 255;
        if (max === rr)
            hue = ((gg - bb) / d) % 6;
        else if (max === gg)
            hue = (bb - rr) / d + 2;
        else
            hue = (rr - gg) / d + 4;
        hue *= 60;
        if (hue < 0)
            hue += 360;
    }
    if (s < 0.15)
        return C.white;
    s = clamp(s * 1.3, 0.55, 0.9);
    const L = clamp(l, 0.55, 0.7);
    const c = (1 - Math.abs(2 * L - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = L - c / 2;
    let [r1, g1, b1] = [0, 0, 0];
    if (hue < 60)
        [r1, g1, b1] = [c, x, 0];
    else if (hue < 120)
        [r1, g1, b1] = [x, c, 0];
    else if (hue < 180)
        [r1, g1, b1] = [0, c, x];
    else if (hue < 240)
        [r1, g1, b1] = [0, x, c];
    else if (hue < 300)
        [r1, g1, b1] = [x, 0, c];
    else
        [r1, g1, b1] = [c, 0, x];
    const hex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${hex(r1)}${hex(g1)}${hex(b1)}`;
}

// Parse lrclib "[mm:ss.xx] line" synced lyrics into [{t, text}] sorted by time.
export function parseLrc(lrc) {
    const out = [];
    for (const line of String(lrc || '').split('\n')) {
        const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
        if (!tags.length)
            continue;
        const text = plain(line.replace(/\[[^\]]*\]/g, ''), 120);
        for (const m of tags)
            out.push({t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text});
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

export function lyricAt(lines, seconds) {
    let cur = '';
    for (const l of lines) {
        if (l.t > seconds + 0.2)
            break;
        cur = l.text;
    }
    return cur;
}
