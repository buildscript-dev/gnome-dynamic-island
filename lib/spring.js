// Damped springs driven by the stage frame clock, standing in for QML's
// SpringAnimation. The original island used SpringAnimation {spring, damping};
// K_SCALE/D_SCALE map those numbers onto real physics so spring 4 / damping
// 0.36 opens with a slight overshoot and 2.6 / 0.33 closes more softly.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const K_SCALE = 100;
const D_SCALE = 60;
const STEP = 1 / 240;

export class Spring {
    constructor(value, {spring = 4, damping = 0.36, epsilon = 0.25} = {}) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.spring = spring;
        this.damping = damping;
        this.epsilon = epsilon;
        this.active = false;
    }

    to(target, params = {}) {
        if (params.spring !== undefined)
            this.spring = params.spring;
        if (params.damping !== undefined)
            this.damping = params.damping;
        this.target = target;
        this.active = Math.abs(this.target - this.value) > this.epsilon / 10 ||
            Math.abs(this.velocity) > this.epsilon;
    }

    jump(value) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.active = false;
    }

    step(dt) {
        if (!this.active)
            return;
        const K = this.spring * K_SCALE;
        const D = this.damping * D_SCALE;
        let left = dt;
        while (left > 0) {
            const h = Math.min(STEP, left);
            const a = K * (this.target - this.value) - D * this.velocity;
            this.velocity += a * h;
            this.value += this.velocity * h;
            left -= h;
        }
        if (Math.abs(this.target - this.value) < this.epsilon &&
            Math.abs(this.velocity) < this.epsilon * 4) {
            this.value = this.target;
            this.velocity = 0;
            this.active = false;
        }
    }
}

// Steps a set of springs every frame while any is moving, then calls onFrame.
export class SpringDriver {
    constructor(actor, onFrame) {
        this._springs = [];
        this._onFrame = onFrame;
        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._last = 0;
    }

    add(spring) {
        this._springs.push(spring);
        return spring;
    }

    kick() {
        if (this._timeline.is_playing())
            return;
        this._last = GLib.get_monotonic_time();
        this._timeline.start();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.05, (now - this._last) / 1e6);
        this._last = now;
        let moving = false;
        for (const s of this._springs) {
            s.step(dt);
            moving ||= s.active;
        }
        this._onFrame();
        if (!moving)
            this._timeline.stop();
    }

    destroy() {
        this._timeline.stop();
        this._timeline.run_dispose?.();
        this._timeline = null;
        this._springs = [];
    }
}
