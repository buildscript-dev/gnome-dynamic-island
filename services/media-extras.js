// Album art (local files or bounded downloads), album tint, synced lyrics
// from lrclib.net and a live spectrum from cava.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {parseLrc, vividColor} from '../lib/model.js';

const ART_MAX = 4 * 1024 * 1024;
const LYRICS_MAX = 256 * 1024;

function runtimeDir() {
    const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gnome-dynamic-island']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

export class MediaExtras extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._session = new Soup.Session({timeout: 12, user_agent: 'gnome-dynamic-island/0.1'});
        this._cancel = new Gio.Cancellable();
        this.artPath = '';
        this.tint = '#FFFFFF';
        this.lyrics = [];
        this.spectrum = [];
        this._artUrl = null;
        this._lyricsKey = null;
        this._cavaFails = 0;
    }

    // --- artwork ------------------------------------------------------------

    updateArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        this._artCancel?.cancel();
        if (!url) {
            this._setArt('');
            return;
        }
        if (url.startsWith('file://')) {
            const path = Gio.File.new_for_uri(url).get_path();
            this._setArt(path && GLib.file_test(path, GLib.FileTest.IS_REGULAR) ? path : '');
            return;
        }
        if (!/^https?:\/\//.test(url) || !this._settings.get_boolean('online-extras')) {
            this._setArt('');
            return;
        }
        const msg = Soup.Message.new('GET', url);
        if (!msg) {
            this._setArt('');
            return;
        }
        this._artCancel = new Gio.Cancellable();
        const cancel = this._artCancel;
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancel, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (cancel.is_cancelled() || msg.get_status() !== Soup.Status.OK)
                    return;
                if (bytes.get_size() > ART_MAX)
                    return;
                const path = GLib.build_filenamev([runtimeDir(),
                    `art-${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)}`]);
                // Keep only the current track's image.
                if (this.artPath && this.artPath.startsWith(runtimeDir()))
                    GLib.unlink(this.artPath);
                GLib.file_set_contents(path, bytes.toArray());
                this._setArt(path);
            } catch (e) {
                if (!cancel.is_cancelled())
                    this._setArt('');
            }
        });
    }

    _setArt(path) {
        this.artPath = path;
        this.tint = '#FFFFFF';
        if (path && this._settings.get_boolean('artwork-tint')) {
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 8, 8, false);
                const px = pb.get_pixels();
                const n = pb.get_n_channels(), stride = pb.get_rowstride();
                let r = 0, g = 0, b = 0, count = 0;
                for (let y = 0; y < pb.get_height(); y++) {
                    for (let x = 0; x < pb.get_width(); x++) {
                        const i = y * stride + x * n;
                        r += px[i];
                        g += px[i + 1];
                        b += px[i + 2];
                        count++;
                    }
                }
                if (count)
                    this.tint = vividColor(r / count, g / count, b / count);
            } catch {}
        }
        this.emit('art-changed');
    }

    // --- lyrics -------------------------------------------------------------

    updateLyrics(meta) {
        const key = `${meta.artist}\u0000${meta.title}`;
        if (key === this._lyricsKey)
            return;
        this._lyricsKey = key;
        this._lyricsCancel?.cancel();
        this.lyrics = [];
        this.emit('lyrics-changed');
        if (!meta.title || !meta.artist || !this._settings.get_boolean('show-lyrics') ||
            !this._settings.get_boolean('online-extras'))
            return;
        const q = {artist_name: meta.artist, track_name: meta.title};
        if (meta.album)
            q.album_name = meta.album;
        if (meta.length > 0)
            q.duration = String(Math.round(meta.length));
        const query = Object.entries(q)
            .map(([k, v]) => `${k}=${GLib.Uri.escape_string(v, null, false)}`).join('&');
        const msg = Soup.Message.new('GET', `https://lrclib.net/api/get?${query}`);
        if (!msg)
            return;
        this._lyricsCancel = new Gio.Cancellable();
        const cancel = this._lyricsCancel;
        this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, cancel, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (cancel.is_cancelled() || msg.get_status() !== Soup.Status.OK ||
                    bytes.get_size() > LYRICS_MAX)
                    return;
                const json = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                this.lyrics = parseLrc(json.syncedLyrics);
                this.emit('lyrics-changed');
            } catch {}
        });
    }

    // --- cava ---------------------------------------------------------------

    _cavaPath() {
        return GLib.find_program_in_path('cava') ??
            ['/home/linuxbrew/.linuxbrew/bin/cava', '/usr/bin/cava']
                .find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
    }

    setPlaying(playing, configPath) {
        const want = playing && this._settings.get_boolean('use-cava') && this._cavaFails < 3;
        if (want && !this._cava)
            this._startCava(configPath);
        else if (!want && this._cava)
            this._stopCava();
    }

    _startCava(configPath) {
        const bin = this._cavaPath();
        if (!bin)
            return;
        try {
            this._cava = Gio.Subprocess.new([bin, '-p', configPath],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            this._cavaFails++;
            this._cava = null;
            return;
        }
        const proc = this._cava;
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const read = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (st, res) => {
                let line;
                try {
                    [line] = st.read_line_finish_utf8(res);
                } catch {
                    line = null;
                }
                if (line === null) {
                    if (this._cava === proc) {
                        this._cava = null;
                        this._cavaFails++;
                        this.spectrum = [];
                        this.emit('spectrum');
                    }
                    return;
                }
                const vals = line.split(';').filter(v => v !== '').map(v => parseInt(v, 10) / 100);
                if (vals.length && vals.every(v => !isNaN(v))) {
                    this.spectrum = vals;
                    this._cavaFails = 0;
                    this.emit('spectrum');
                }
                if (this._cava === proc)
                    read();
            });
        };
        read();
    }

    _stopCava() {
        const proc = this._cava;
        this._cava = null;
        proc?.force_exit();
        this.spectrum = [];
        this.emit('spectrum');
    }

    destroy() {
        this._cancel.cancel();
        this._artCancel?.cancel();
        this._lyricsCancel?.cancel();
        this._stopCava();
        this._session.abort();
        if (this.artPath && this.artPath.startsWith(runtimeDir()))
            GLib.unlink(this.artPath);
    }
}
