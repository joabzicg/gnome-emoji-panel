// Emoji Panel: a Windows-style emoji picker that lives inside GNOME Shell.
//
// The panel is shell chrome (like the on-screen keyboard), so clicking it
// never takes keyboard focus away from the app you are typing in. Emojis are
// committed through the input method when the app supports it, otherwise
// they are pasted with a virtual Ctrl+V.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const COLUMNS = 9;
const MAX_RECENT = 36;
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 380;
const DEFAULT_RECENT = ['😂', '❤️', '👍', '😭', '🙏', '😍', '🔥', '🥰', '😊', '🤣', '😅', '👀'];
const TAB_ICONS = ['😀', '👋', '🐻', '🍔', '✈️', '⚽', '💡', '🔣', '🏁'];
const GROUP_TITLES = ['Carinhas e emoções', 'Pessoas e corpo', 'Animais e natureza',
    'Comida e bebida', 'Viagens e lugares', 'Atividades', 'Objetos', 'Símbolos', 'Bandeiras'];
const TERMINAL_RE = /terminal|kitty|alacritty|wezterm|konsole|tilix|ptyxis|terminator|xterm|foot/i;

export default class EmojiPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._groups = this._loadGroups();
        this._sources = new Set();
        this._grids = new Map();
        this._cursorRect = null;
        this._recentDirty = true;

        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._buildPanel();

        Main.inputMethod.connectObject('cursor-location-changed', (_im, rect) => {
            this._cursorRect = {
                x: rect.get_x(), y: rect.get_y(),
                width: rect.get_width(), height: rect.get_height(),
            };
        }, this);
        Main.overview.connectObject('showing', () => this._hide(), this);

        Main.wm.addKeybinding('toggle-panel', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._toggle());
    }

    disable() {
        this._hide();
        Main.wm.removeKeybinding('toggle-panel');
        Main.inputMethod.disconnectObject(this);
        Main.overview.disconnectObject(this);
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources = null;
        this._panel.destroy();
        this._panel = null;
        this._grids = null;
        this._keyboard = null;
        this._settings = null;
        this._groups = null;
    }

    _timeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const again = fn();
            if (!again)
                this._sources.delete(id);
            return again ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    _loadGroups() {
        const [, bytes] = GLib.file_get_contents(`${this.path}/emojis.json`);
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    _buildPanel() {
        this._panel = new St.BoxLayout({
            style_class: 'emoji-panel',
            vertical: true,
            reactive: true,
            visible: false,
            width: PANEL_WIDTH,
            height: PANEL_HEIGHT,
        });

        this._tabBar = new St.BoxLayout({style_class: 'emoji-panel-tabs'});
        this._tabs = [];
        const icons = ['🕘', ...TAB_ICONS];
        icons.forEach((icon, index) => {
            const tab = new St.Button({
                style_class: 'emoji-panel-tab',
                label: icon,
                can_focus: false,
                x_expand: true,
            });
            tab.connect('clicked', () => this._selectTab(index));
            this._tabBar.add_child(tab);
            this._tabs.push(tab);
        });
        this._panel.add_child(this._tabBar);

        this._title = new St.Label({style_class: 'emoji-panel-title'});
        this._panel.add_child(this._title);

        this._scroll = new St.ScrollView({
            style_class: 'emoji-panel-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._panel.add_child(this._scroll);

        Main.layoutManager.addTopChrome(this._panel);
        this._currentTab = 0;
    }

    _buildGrid(emojis) {
        const box = new St.BoxLayout({vertical: true, style_class: 'emoji-panel-grid'});
        for (let i = 0; i < emojis.length; i += COLUMNS) {
            const row = new St.BoxLayout({style_class: 'emoji-panel-row'});
            for (const emoji of emojis.slice(i, i + COLUMNS)) {
                const button = new St.Button({
                    style_class: 'emoji-panel-emoji',
                    label: emoji,
                    can_focus: false,
                });
                button.connect('clicked', () => this._insert(emoji));
                row.add_child(button);
            }
            box.add_child(row);
        }
        return box;
    }

    _gridFor(index) {
        if (index === 0) {
            if (this._recentDirty || !this._grids.has(0)) {
                this._grids.get(0)?.destroy();
                const recent = this._settings.get_strv('recent');
                this._grids.set(0, this._buildGrid(recent.length ? recent : DEFAULT_RECENT));
                this._recentDirty = false;
            }
        } else if (!this._grids.has(index)) {
            this._grids.set(index, this._buildGrid(this._groups[index - 1].emojis));
        }
        return this._grids.get(index);
    }

    _selectTab(index) {
        this._currentTab = index;
        this._tabs.forEach((tab, i) => {
            if (i === index)
                tab.add_style_class_name('active');
            else
                tab.remove_style_class_name('active');
        });
        this._title.text = index === 0 ? 'Usados recentemente'
            : GROUP_TITLES[index - 1] ?? this._groups[index - 1].name;

        const grid = this._gridFor(index);
        if (this._scroll.child !== grid) {
            // Keep cached grids alive: detach without destroying.
            const old = this._scroll.child;
            if (old)
                this._scroll.remove_child(old);
            this._scroll.child = grid;
        }
        const adjustment = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        adjustment?.set_value(0);
    }

    _toggle() {
        if (this._panel.visible)
            this._hide();
        else
            this._show();
    }

    _show() {
        if (this._recentDirty && this._scroll.child === this._grids.get(0)) {
            this._scroll.remove_child(this._grids.get(0));
            this._scroll.child = null;
        }
        this._selectTab(0);
        this._position();
        this._panel.show();

        Main.wm.addKeybinding('close-panel', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._hide());

        // Shell chrome never sees clicks that land on windows, so watch the
        // pointer while open and close on any press outside the panel.
        this._pollId = this._timeout(50, () => {
            const [x, y, mods] = global.get_pointer();
            const pressed = mods & (Clutter.ModifierType.BUTTON1_MASK |
                Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK);
            if (pressed && !this._contains(x, y)) {
                this._pollId = null;
                this._hide();
                return false;
            }
            return true;
        });
    }

    _hide() {
        if (!this._panel?.visible)
            return;
        this._panel.hide();
        Main.wm.removeKeybinding('close-panel');
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._sources.delete(this._pollId);
            this._pollId = null;
        }
    }

    _contains(x, y) {
        const [px, py] = this._panel.get_transformed_position();
        return x >= px && x < px + PANEL_WIDTH && y >= py && y < py + PANEL_HEIGHT;
    }

    _position() {
        const monitor = Main.layoutManager.currentMonitor;
        let x, y;
        const rect = this._cursorRect;
        if (Main.inputMethod.currentFocus && rect) {
            x = rect.x;
            y = rect.y + rect.height + 6;
            if (y + PANEL_HEIGHT > monitor.y + monitor.height)
                y = rect.y - PANEL_HEIGHT - 6;
        } else {
            [x, y] = global.get_pointer();
            y += 12;
            if (y + PANEL_HEIGHT > monitor.y + monitor.height)
                y -= PANEL_HEIGHT + 24;
        }
        x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - PANEL_WIDTH - 8));
        y = Math.max(monitor.y + 8, Math.min(y, monitor.y + monitor.height - PANEL_HEIGHT - 8));
        this._panel.set_position(Math.round(x), Math.round(y));
    }

    _insert(emoji) {
        if (Main.inputMethod.currentFocus)
            Main.inputMethod.commit(emoji);
        else
            this._paste(emoji);
        this._addRecent(emoji);
    }

    _paste(text) {
        const clipboard = St.Clipboard.get_default();
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clip, previous) => {
            if (!this._sources)
                return;
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            const wmClass = global.display.focus_window?.get_wm_class() ?? '';
            this._timeout(30, () => {
                this._sendPaste(TERMINAL_RE.test(wmClass));
                if (previous !== null) {
                    this._timeout(500, () => {
                        clipboard.set_text(St.ClipboardType.CLIPBOARD, previous);
                        return false;
                    });
                }
                return false;
            });
        });
    }

    _sendPaste(withShift) {
        const time = GLib.get_monotonic_time();
        const keys = withShift
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        for (const key of keys)
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }

    _addRecent(emoji) {
        const recent = this._settings.get_strv('recent').filter(e => e !== emoji);
        recent.unshift(emoji);
        this._settings.set_strv('recent', recent.slice(0, MAX_RECENT));
        // Rebuilt on next open so the grid does not jump while clicking.
        this._recentDirty = true;
    }
}
