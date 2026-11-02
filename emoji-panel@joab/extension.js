// Emoji Panel: a Windows-style emoji picker that lives inside GNOME Shell.
//
// The panel is shell chrome (like the on-screen keyboard), so clicking it
// never takes keyboard focus away from the app you are typing in. Emojis are
// committed through the input method when the app supports it, otherwise
// they are pasted with a virtual Ctrl+V.
//
// The search box is the one exception: typing needs keyboard focus, so while
// it is focused the app is not. Inserting an emoji hands focus back to the
// app first and waits for its input method to come back before committing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const COLUMNS = 9;
const MAX_RECENT = 36;
const MAX_RESULTS = 90;
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 420;
const FOCUS_WAIT_US = 300 * 1000;
const DEFAULT_RECENT = ['😂', '❤️', '👍', '😭', '🙏', '😍', '🔥', '🥰', '😊', '🤣', '😅', '👀'];
const TAB_ICONS = ['😀', '👋', '🐻', '🍔', '✈️', '⚽', '💡', '🔣', '🏁'];
const GROUP_TITLES = ['Carinhas e emoções', 'Pessoas e corpo', 'Animais e natureza',
    'Comida e bebida', 'Viagens e lugares', 'Atividades', 'Objetos', 'Símbolos', 'Bandeiras'];
const TERMINAL_RE = /terminal|kitty|alacritty|wezterm|konsole|tilix|ptyxis|terminator|xterm|foot/i;

function normalize(text) {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export default class EmojiPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._groups = this._loadJson('emojis.json');
        this._keywords = this._loadJson('keywords.json');
        this._sources = new Set();
        this._grids = new Map();
        this._searchGrid = null;
        this._results = [];
        this._queue = [];
        this._waitId = null;
        this._pasteQueue = [];
        this._pasting = false;
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
        for (const grid of this._grids.values())
            grid.destroy();
        this._searchGrid?.destroy();
        this._panel = null;
        this._grids = null;
        this._searchGrid = null;
        this._selected = null;
        this._keyboard = null;
        this._settings = null;
        this._groups = null;
        this._keywords = null;
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

    _loadJson(name) {
        const [, bytes] = GLib.file_get_contents(`${this.path}/${name}`);
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

        this._entry = new St.Entry({
            style_class: 'emoji-panel-search',
            hint_text: 'Pesquisar emoji',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'emoji-panel-search-icon',
        }));
        this._entry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._panel.add_child(this._entry);

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
            tab.connect('clicked', () => {
                this._entry.text = '';
                this._selectTab(index);
            });
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
        box.firstButton = null;
        for (let i = 0; i < emojis.length; i += COLUMNS) {
            const row = new St.BoxLayout({style_class: 'emoji-panel-row'});
            for (const emoji of emojis.slice(i, i + COLUMNS)) {
                const button = new St.Button({
                    style_class: 'emoji-panel-emoji',
                    label: emoji,
                    can_focus: false,
                });
                button.emoji = emoji;
                box.firstButton ??= button;
                button.connect('clicked', () => this._insert(emoji));
                button.connect('notify::hover', () => {
                    this._title.text = button.hover
                        ? this._keywords[emoji]?.[0] ?? this._titleText
                        : this._titleText;
                });
                row.add_child(button);
            }
            box.add_child(row);
        }
        return box;
    }

    _gridFor(index) {
        if (index === 0) {
            if (this._recentDirty || !this._grids.has(0)) {
                if (this._scroll.child === this._grids.get(0))
                    this._setGrid(null);
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

    _setGrid(grid) {
        const old = this._scroll.child;
        if (old === grid)
            return;
        this._selected?.remove_style_class_name('selected');
        this._selected = null;
        // Category grids are cached, so detach them without destroying.
        if (old)
            this._scroll.remove_child(old);
        if (old && old === this._searchGrid) {
            old.destroy();
            this._searchGrid = null;
        }
        if (grid)
            this._scroll.child = grid;
        // Enter inserts the first emoji shown, so that is the one highlighted.
        this._selected = grid?.firstButton ?? null;
        this._selected?.add_style_class_name('selected');
        const adjustment = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        adjustment?.set_value(0);
    }

    _insertSelected() {
        // The first search result or, with an empty search, the first emoji
        // shown (the most recent one when the panel opens). The recent grid
        // keeps its order while open, so repeated presses repeat the emoji.
        if (this._selected)
            this._insert(this._selected.emoji);
    }

    _setTitle(text) {
        this._titleText = text;
        this._title.text = text;
    }

    _selectTab(index) {
        this._currentTab = index;
        this._results = [];
        this._tabs.forEach((tab, i) => {
            if (i === index)
                tab.add_style_class_name('active');
            else
                tab.remove_style_class_name('active');
        });
        this._setTitle(index === 0 ? 'Usados recentemente'
            : GROUP_TITLES[index - 1] ?? this._groups[index - 1].name);
        this._setGrid(this._gridFor(index));
    }

    _onSearchChanged() {
        const query = normalize(this._entry.text.trim());
        if (!query) {
            if (this._searchGrid)
                this._selectTab(this._currentTab);
            return;
        }
        this._tabs.forEach(tab => tab.remove_style_class_name('active'));
        this._results = this._search(query);
        const grid = this._buildGrid(this._results);
        this._setGrid(grid);
        this._searchGrid = grid;
        this._setTitle(this._results.length ? 'Resultados' : 'Nenhum emoji encontrado');
    }

    _search(query) {
        const words = query.split(/\s+/);
        const matches = [];
        let order = 0;
        for (const [emoji, [, nameText, wordText]] of Object.entries(this._keywords)) {
            order++;
            const text = `${nameText}|${wordText}`;
            if (!words.every(w => text.includes(w)))
                continue;
            // Best first: a name (in any language), a name starting with the
            // query, an exact keyword, a keyword starting with it, the rest.
            const names = nameText.split('|');
            const keywords = wordText.split('|');
            let score = 4;
            if (names.includes(query))
                score = 0;
            else if (names.some(n => n.startsWith(query)))
                score = 1;
            else if (keywords.includes(query))
                score = 2;
            else if (keywords.some(k => k.startsWith(query)))
                score = 3;
            matches.push([score, order, emoji]);
        }
        matches.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return matches.slice(0, MAX_RESULTS).map(m => m[2]);
    }

    _toggle() {
        if (this._panel.visible)
            this._hide();
        else
            this._show();
    }

    _show() {
        this._targetWindow = global.display.focus_window;
        this._entry.text = '';
        this._selectTab(0);
        this._position();
        this._panel.show();
        // Like on Windows, typing right away searches.
        this._entry.grab_key_focus();

        Main.wm.addKeybinding('close-panel', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._hide());
        // Enter belongs to the panel while it is open, whoever has focus, so
        // pressing it again repeats the emoji instead of reaching the app.
        Main.wm.addKeybinding('insert-selected', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._insertSelected());

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
        const searching = this._searchFocused();
        this._panel.hide();
        Main.wm.removeKeybinding('close-panel');
        Main.wm.removeKeybinding('insert-selected');
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._sources.delete(this._pollId);
            this._pollId = null;
        }
        if (searching)
            this._returnFocus();
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

    _searchFocused() {
        const focus = global.stage.get_key_focus();
        return focus !== null && this._panel.contains(focus);
    }

    _returnFocus() {
        global.stage.set_key_focus(null);
        const win = this._targetWindow;
        if (win && !win.has_focus())
            win.activate(global.get_current_time());
        // Dropping stage focus refocuses the window but does not re-enter its
        // text input; a grab round-trip makes mutter resync keyboard focus,
        // the same way closing the overview does.
        global.stage.grab(global.stage).dismiss();
    }

    _insert(emoji) {
        this._addRecent(emoji);
        this._queue.push(emoji);
        if (this._waitId)
            return;
        // Leaving the search box: wait for the app's input method to return.
        // Otherwise just batch clicks that land together, since mutter keeps
        // only the last commit sent within one frame.
        let deadline = GLib.get_monotonic_time();
        if (this._searchFocused()) {
            this._returnFocus();
            deadline += FOCUS_WAIT_US;
        }
        this._waitId = this._timeout(15, () => {
            if (!Main.inputMethod.currentFocus && GLib.get_monotonic_time() < deadline)
                return true;
            this._waitId = null;
            this._flush();
            return false;
        });
    }

    _flush() {
        const text = this._queue.join('');
        this._queue = [];
        if (Main.inputMethod.currentFocus)
            Main.inputMethod.commit(text);
        else
            this._paste(text);
    }

    _paste(text) {
        // Pastes run one at a time: the app reads the clipboard asynchronously,
        // so replacing it while a Ctrl+V is in flight would paste the wrong emoji.
        this._pasteQueue.push(text);
        if (this._pasting)
            return;
        this._pasting = true;
        const clipboard = St.Clipboard.get_default();
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clip, previous) => {
            if (!this._sources)
                return;
            const next = () => {
                if (!this._pasteQueue.length) {
                    this._pasting = false;
                    if (previous !== null)
                        clipboard.set_text(St.ClipboardType.CLIPBOARD, previous);
                    return false;
                }
                clipboard.set_text(St.ClipboardType.CLIPBOARD, this._pasteQueue.join(''));
                this._pasteQueue = [];
                const wmClass = global.display.focus_window?.get_wm_class() ?? '';
                this._timeout(30, () => {
                    this._sendPaste(TERMINAL_RE.test(wmClass));
                    this._timeout(300, next);
                    return false;
                });
                return false;
            };
            next();
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
