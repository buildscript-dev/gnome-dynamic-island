// Takes over GNOME's OSD (volume, brightness, keyboard) and notification
// banners, and hides the top bar. Everything is restored on destroy().

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {G, volumeGlyph, plain} from '../lib/model.js';

function iconName(gicon) {
    if (!gicon)
        return '';
    if (gicon instanceof Gio.ThemedIcon)
        return gicon.get_names()[0] ?? '';
    return gicon.to_string?.() ?? '';
}

// Map a GNOME OSD call onto an island activity, like osdTransient() did for
// `omarchy osd`. level is a fraction of maxLevel (maxLevel > 1 = over-amplified).
export function osdActivity(gicon, label, level, maxLevel) {
    const name = iconName(gicon).toLowerCase();
    const hasLevel = level !== undefined && level !== null && level >= 0;
    const percent = hasLevel ? Math.round(level * 100) : -1;
    let icon = G.bell, tint = 'white', source = 'generic';
    if (name.includes('audio-volume') || name.includes('audio-speakers') || name.includes('audio-headphones')) {
        source = 'volume';
        icon = name.includes('headphones') ? G.headphones : volumeGlyph(percent, name.includes('muted'));
    } else if (name.includes('microphone')) {
        source = 'mic';
        const off = name.includes('muted');
        icon = off ? G.micOff : G.mic;
        tint = off ? 'red' : 'orange';
    } else if (name.includes('keyboard-brightness')) {
        source = 'keyboard';
        icon = G.keyboard;
    } else if (name.includes('brightness') || name.includes('display')) {
        source = 'brightness';
        icon = percent >= 0 && percent < 50 ? G.brightLow : G.brightHigh;
    } else if (name.includes('airplane')) {
        source = 'airplane';
        icon = G.wifi;
    } else if (name.includes('input-keyboard') || name.includes('caps')) {
        source = 'keyboard';
        icon = G.keyboard;
    } else if (name.includes('touchpad') || name.includes('mouse')) {
        source = 'touchpad';
    }
    if (hasLevel) {
        return {kind: 'hud', source, icon, tint, percent, max: Math.round((maxLevel || 1) * 100),
            title: label ? plain(label, 40) : '', value: `${percent}%`, duration: 1500};
    }
    return {kind: 'alert', source, icon, tint, title: plain(label || '', 60), value: '', duration: 2000};
}

export class ShellHooks extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._sourceIds = new Map();
    }

    // --- OSD ------------------------------------------------------------------

    hookOsd() {
        const osd = Main.osdWindowManager;
        if (this._osdOrig)
            return;
        this._osdOrig = {show: osd.show, showAll: osd.showAll, showOne: osd.showOne};
        const take = () => this._settings.get_boolean('replace-osd');
        osd.show = (icon, label, levels) => {
            if (!take())
                return this._osdOrig.show.call(osd, icon, label, levels);
            const first = Object.values(levels ?? {}).find(Boolean) ?? {};
            this.emit('osd', osdActivity(icon, label, first.level, first.maxLevel));
            return undefined;
        };
        osd.showAll = (icon, label, level, maxLevel) => {
            if (!take())
                return this._osdOrig.showAll.call(osd, icon, label, level, maxLevel);
            this.emit('osd', osdActivity(icon, label, level, maxLevel));
            return undefined;
        };
        osd.showOne = (monitorIndex, icon, label, level, maxLevel) => {
            if (!take())
                return this._osdOrig.showOne.call(osd, monitorIndex, icon, label, level, maxLevel);
            this.emit('osd', osdActivity(icon, label, level, maxLevel));
            return undefined;
        };
    }

    unhookOsd() {
        if (!this._osdOrig)
            return;
        Object.assign(Main.osdWindowManager, this._osdOrig);
        // Drop our own-property overrides so the prototype methods show through.
        for (const k of ['show', 'showAll', 'showOne'])
            delete Main.osdWindowManager[k];
        this._osdOrig = null;
    }

    // --- notifications ----------------------------------------------------------

    hookNotifications() {
        const tray = Main.messageTray;
        this._trayId = tray.connect('source-added', (_t, source) => this._watchSource(source));
        tray.getSources().forEach(s => this._watchSource(s));
        this._syncBannerBlock();
        this._settingsId = this._settings.connect('changed::show-notifications',
            () => this._syncBannerBlock());
        // The date menu un-blocks banners when it closes; block them again.
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu?.menu) {
            this._dateMenuId = dateMenu.menu.connect('open-state-changed', () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._syncBannerBlock();
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    _syncBannerBlock() {
        const dateOpen = Main.panel.statusArea.dateMenu?.menu?.isOpen;
        Main.messageTray.bannerBlocked = this._settings.get_boolean('show-notifications') || !!dateOpen;
    }

    _watchSource(source) {
        if (this._sourceIds.has(source))
            return;
        const ids = [
            source.connect('notification-request-banner', (_s, n) => this._onBanner(n)),
            source.connect('destroy', () => this._sourceIds.delete(source)),
        ];
        this._sourceIds.set(source, ids);
    }

    // Same filter GNOME uses before showing a banner.
    _onBanner(n) {
        if (!this._settings.get_boolean('show-notifications'))
            return;
        if (n.acknowledged || n.urgency === MessageTray.Urgency.LOW)
            return;
        if (!n.source.policy.showBanners && n.urgency !== MessageTray.Urgency.CRITICAL)
            return;
        n.playSound();
        this.emit('notification', n);
    }

    unhookNotifications() {
        if (this._trayId)
            Main.messageTray.disconnect(this._trayId);
        this._trayId = 0;
        for (const [source, ids] of this._sourceIds)
            ids.forEach(id => source.disconnect(id));
        this._sourceIds.clear();
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        if (this._dateMenuId)
            Main.panel.statusArea.dateMenu.menu.disconnect(this._dateMenuId);
        this._dateMenuId = 0;
        Main.messageTray.bannerBlocked = false;
    }

    // --- top bar --------------------------------------------------------------

    hideTopBar(hide) {
        const box = Main.layoutManager.panelBox;
        if (hide && !this._panelHidden) {
            this._panelHidden = true;
            const apply = () => {
                if (Main.overview.visible)
                    return;
                box.translation_y = -box.height;
                box.hide();
                Main.layoutManager._queueUpdateRegions?.();
            };
            const restore = () => {
                box.translation_y = 0;
                box.show();
                Main.layoutManager._queueUpdateRegions?.();
            };
            this._overviewIds = [
                Main.overview.connect('showing', restore),
                Main.overview.connect('hidden', apply),
            ];
            this._boxId = box.connect('notify::height', () => {
                if (this._panelHidden && !Main.overview.visible)
                    box.translation_y = -box.height;
            });
            apply();
        } else if (!hide && this._panelHidden) {
            this._panelHidden = false;
            this._overviewIds?.forEach(id => Main.overview.disconnect(id));
            this._overviewIds = null;
            if (this._boxId)
                box.disconnect(this._boxId);
            this._boxId = 0;
            box.translation_y = 0;
            box.show();
            Main.layoutManager._queueUpdateRegions?.();
        }
    }

    destroy() {
        this.unhookOsd();
        this.unhookNotifications();
        this.hideTopBar(false);
    }
}
