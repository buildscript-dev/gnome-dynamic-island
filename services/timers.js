// Timer, stopwatch and alarm. One second ticker while anything runs.
// The alarm time is kept in GSettings so it survives a shell restart.

import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const now = () => GLib.get_monotonic_time() / 1e6;

export class TimerService extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.timer = null;      // {total, end, remaining, paused}
        this.stopwatch = null;  // {start, acc, running}
        this.alarm = null;      // {hh, mm, at: unix seconds}
        this.ringing = false;
        this._snoozeUntil = 0;
        const saved = settings.get_string('alarm-time');
        if (saved)
            this.setAlarm(saved, false);
        this._tickId = 0;
        this._sync();
    }

    // --- timer ---

    startTimer(seconds) {
        this.timer = {total: seconds, end: now() + seconds, remaining: seconds, paused: false};
        this._sync();
    }

    toggleTimer() {
        const t = this.timer;
        if (!t)
            return;
        if (t.paused) {
            t.end = now() + t.remaining;
            t.paused = false;
        } else {
            t.remaining = Math.max(0, t.end - now());
            t.paused = true;
        }
        this._sync();
    }

    cancelTimer() {
        this.timer = null;
        this._sync();
    }

    get timerLeft() {
        const t = this.timer;
        if (!t)
            return 0;
        return t.paused ? t.remaining : Math.max(0, t.end - now());
    }

    // --- stopwatch ---

    toggleStopwatch() {
        const s = this.stopwatch;
        if (!s)
            this.stopwatch = {start: now(), acc: 0, running: true};
        else if (s.running)
            Object.assign(s, {acc: s.acc + now() - s.start, running: false});
        else
            Object.assign(s, {start: now(), running: true});
        this._sync();
    }

    resetStopwatch() {
        if (this.stopwatch && this.stopwatchElapsed > 1)
            this.emit('stopwatch-finished', this.stopwatchElapsed);
        this.stopwatch = null;
        this._sync();
    }

    get stopwatchElapsed() {
        const s = this.stopwatch;
        if (!s)
            return 0;
        return s.running ? s.acc + now() - s.start : s.acc;
    }

    // --- alarm ---

    setAlarm(text, save = true) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
        if (!m || +m[1] > 23 || +m[2] > 59)
            return false;
        const hh = +m[1], mm = +m[2];
        const nowDt = GLib.DateTime.new_now_local();
        let at = GLib.DateTime.new_local(nowDt.get_year(), nowDt.get_month(),
            nowDt.get_day_of_month(), hh, mm, 0);
        if (at.to_unix() <= nowDt.to_unix())
            at = at.add_days(1);
        this.alarm = {hh, mm, at: at.to_unix()};
        if (save)
            this._settings.set_string('alarm-time', `${hh}:${String(mm).padStart(2, '0')}`);
        this._sync();
        return true;
    }

    cancelAlarm() {
        this.alarm = null;
        this.ringing = false;
        this._settings.set_string('alarm-time', '');
        this._sync();
    }

    stopAlarm() {
        this.ringing = false;
        this.alarm = null;
        this._settings.set_string('alarm-time', '');
        this._sync();
    }

    snoozeAlarm() {
        this.ringing = false;
        const at = GLib.DateTime.new_now_local().add_minutes(9).to_unix();
        this.alarm = {...this.alarm, at};
        this._sync();
    }

    // --- ticking ---

    get running() {
        return !!(this.timer || this.stopwatch?.running || this.alarm || this.ringing);
    }

    _sync() {
        if (this.running && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this.running && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this.emit('changed');
    }

    _tick() {
        if (this.timer && !this.timer.paused && this.timerLeft <= 0) {
            const total = this.timer.total;
            this.timer = null;
            this.emit('timer-done', total);
            this._sync();
        }
        if (this.alarm && !this.ringing && GLib.get_real_time() / 1e6 >= this.alarm.at) {
            this.ringing = true;
            this.emit('alarm-ring');
            this._sync();
        }
        this.emit('tick');
    }

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }
}
