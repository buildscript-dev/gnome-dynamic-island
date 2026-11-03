// Dynamic Island for GNOME, ported from omarchy-dynamic-island.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Island} from './island.js';
import {IslandDBus} from './dbus.js';
import {MprisService} from './services/mpris.js';
import {MediaExtras} from './services/media-extras.js';
import {SystemService} from './services/system.js';
import {TimerService} from './services/timers.js';
import {ShellHooks} from './services/shell-hooks.js';

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._hooks = new ShellHooks(this._settings);
        this._mpris = new MprisService();
        this._media = new MediaExtras(this._settings);
        this._system = new SystemService();
        this._timers = new TimerService(this._settings);

        this._island = new Island({
            settings: this._settings,
            path: this.path,
            mpris: this._mpris,
            media: this._media,
            system: this._system,
            timers: this._timers,
            hooks: this._hooks,
        });
        this._dbus = new IslandDBus(this._island);

        this._hooks.hookOsd();
        this._hooks.hookNotifications();
        this._hooks.hideTopBar(this._settings.get_boolean('hide-top-bar'));
        this._barId = this._settings.connect('changed::hide-top-bar',
            () => this._hooks.hideTopBar(this._settings.get_boolean('hide-top-bar')));
    }

    disable() {
        if (this._barId)
            this._settings.disconnect(this._barId);
        this._barId = 0;
        this._dbus?.destroy();
        this._island?.destroy();
        this._hooks?.destroy();
        this._timers?.destroy();
        this._system?.destroy();
        this._media?.destroy();
        this._mpris?.destroy();
        this._dbus = this._island = this._hooks = this._timers = null;
        this._system = this._media = this._mpris = null;
        this._settings = null;
    }
}
