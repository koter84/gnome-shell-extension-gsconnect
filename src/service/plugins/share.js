'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Bluetooth = imports.service.bluetooth;
const Lan = imports.service.lan;
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Share'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Share',
    incomingCapabilities: ['kdeconnect.share.request'],
    outgoingCapabilities: ['kdeconnect.share.request'],
    actions: {
        shareDialog: {
            label: _('Share'),
            icon_name: 'send-to-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        },
        shareFile: {
            label: _('Share File'),
            icon_name: 'document-send-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        },
        shareText: {
            label: _('Share Text'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        },
        shareUri: {
            label: _('Share Link'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request']
        }
    }
};


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 *
 * TODO: receiving 'text' TODO: Window with textview & 'Copy to Clipboard..
 *       https://github.com/KDE/kdeconnect-kde/commit/28f11bd5c9a717fb9fbb3f02ddd6cea62021d055
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectSharePlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'share');
    }

    connected() {
        super.connected();

        if (this.device.connection_type === 'bluetooth') {
            this.device.lookup_action('shareFile').enabled = false;
        }
    }

    /**
     * Get a GFile for @filename in ~/Downloads, with a numbered suffix if it
     * already exists (eg. `picture.jpg (1)`)
     *
     * @param {String} filename - The basename of the file
     * @return {Gio.File} - A new GFile for the given @filename in ~/Downloads
     */
    _getFile(filename) {
        let download_dir = GLib.get_user_special_dir(
            GLib.UserDirectory.DIRECTORY_DOWNLOAD
        );

        // Account for some corner cases with a fallback
        if (!download_dir || download_dir === GLib.get_home_dir()) {
            download_dir = GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        }

        let path = GLib.build_filenamev([download_dir, filename]);
        let filepath = path;
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS)) {
            copyNum += 1;
            filepath = `${path} (${copyNum})`;
        }

        return Gio.File.new_for_path(filepath);
    }

    async _handleFile(packet) {
        let file, stream, success, transfer;
        let title, body, iconName;
        let buttons = [];

        try {
            file = this._getFile(packet.body.filename);

            stream = await new Promise((resolve, reject) => {
                file.replace_async(null, false, 0, 0, null, (file, res) => {
                    try {
                        resolve(file.replace_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            transfer = new Lan.Transfer({
                device: this.device,
                output_stream: stream,
                size: packet.payloadSize
            });

            // Notify that we're about to start the transfer
            this.device.showNotification({
                id: transfer.uuid,
                title: _('Starting Transfer'),
                // TRANSLATORS: eg. Receiving 'book.pdf' from Google Pixel
                body: _('Receiving "%s" from %s').format(
                    packet.body.filename,
                    this.device.name
                ),
                buttons: [{
                    label: _('Cancel'),
                    action: 'cancelTransfer',
                    parameter: new GLib.Variant('s', transfer.uuid)
                }],
                icon: new Gio.ThemedIcon({ name: 'document-save-symbolic' })
            });

            // Start transfer
            success = await transfer.download(packet.payloadTransferInfo.port);

            if (success) {
                title = _('Transfer Successful');
                // TRANSLATORS: eg. Received 'book.pdf' from Google Pixel
                body = _('Received "%s" from %s').format(
                    packet.body.filename,
                    this.device.name
                );
                buttons = [
                    {
                        label: _('Open Folder'),
                        action: 'openPath',
                        parameter: new GLib.Variant('s', file.get_parent().get_uri())
                    },
                    {
                        label: _('Open File'),
                        action: 'openPath',
                        parameter: new GLib.Variant('s', file.get_uri())
                    }
                ];
                iconName = 'document-save-symbolic';
            } else {
                title = _('Transfer Failed');
                // TRANSLATORS: eg. Failed to receive 'book.pdf' from Google Pixel
                body = _('Failed to receive "%s" from %s').format(
                    packet.body.filename,
                    this.device.name
                );
                iconName = 'dialog-warning-symbolic';

                // Clean up the downloaded file on failure
                file.delete(null);
            }

            this.device.hideNotification(transfer.uuid);
            this.device.showNotification({
                id: transfer.uuid,
                title: title,
                body: body,
                buttons: buttons,
                icon: new Gio.ThemedIcon({ name: iconName })
            });
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    _handleUri(packet) {
        Gio.AppInfo.launch_default_for_uri_async(
            packet.body.url,
            null,
            null,
            (src, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (e) {
                    logError(e);
                }
            }
        );
    }

    // TODO: Not implemented
    _handleText(packet) {
    }

    /**
     * Packet dispatch
     */
    handlePacket(packet) {
        debug('Share: handlePacket()');

        if (packet.body.hasOwnProperty('filename')) {
            this._handleFile(packet);
        } else if (packet.body.hasOwnProperty('text')) {
            this._handleText(packet);
        } else if (packet.body.hasOwnProperty('url')) {
            this._handleUri(packet);
        }
    }

    /**
     * Remote methods
     */
    shareDialog() {
        debug('opening FileChooserDialog');

        let dialog = new FileChooserDialog(this.device);
        dialog.show();
    }

    /**
     * Share local file path or URI
     *
     * @param {string} path - Local file path or file URI
     */
    async shareFile(path) {
        let file, stream, success, transfer;
        let title, body, iconName;

        try {
            if (path.startsWith('file://')) {
                file = Gio.File.new_for_uri(path);
            } else {
                file = Gio.File.new_for_path(path);
            }

            stream = await new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                    try {
                        resolve(file.read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            let info = file.query_info('standard::size', 0, null);

            if (this.device.connection_type === 'bluetooth') {
                transfer = new Bluetooth.Transfer({
                    device: this.device,
                    input_stream: stream,
                    size: info.get_size()
                });
            } else if (this.device.connection_type === 'tcp') {
                transfer = new Lan.Transfer({
                    device: this.device,
                    input_stream: stream,
                    size: info.get_size()
                });
            }

            // Notify that we're about to start the transfer
            this.device.showNotification({
                id: transfer.uuid,
                title: _('Starting Transfer'),
                // TRANSLATORS: eg. Sending 'book.pdf' to Google Pixel
                body: _('Sending "%s" to %s').format(
                    file.get_basename(),
                    this.device.name
                ),
                buttons: [{
                    label: _('Cancel'),
                    action: 'cancelTransfer',
                    parameter: new GLib.Variant('s', transfer.uuid)
                }],
                icon: new Gio.ThemedIcon({ name: 'document-send-symbolic' })
            });

            success = await transfer.upload({
                id: 0,
                type: 'kdeconnect.share.request',
                body: { filename: file.get_basename() }
            });

            if (success) {
                title = _('Transfer Successful');
                // TRANSLATORS: eg. Sent "book.pdf" to Google Pixel
                body = _('Sent "%s" to %s').format(
                    file.get_basename(),
                    this.device.name
                );
                iconName = 'document-send-symbolic';
            } else {
                title = _('Transfer Failed');
                // TRANSLATORS: eg. Failed to send "book.pdf" to Google Pixel
                body = _('Failed to send "%s" to %s').format(
                    file.get_basename(),
                    this.device.name
                );
                iconName = 'dialog-warning-symbolic';
            }

            this.device.hideNotification(transfer.uuid);
            this.device.showNotification({
                id: transfer.uuid,
                title: title,
                body: body,
                icon: new Gio.ThemedIcon({ name: iconName })
            });
        } catch (e) {
            logWarning(e, this.device.name);
        }
    }

    /**
     * Share a string of text. Remote behaviour is undefined.
     *
     * @param {string} text - A string of unicode text
     */
    shareText(text) {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.share.request',
            body: { text: text }
        });
    }

    /**
     * Share a URI. Generally the remote device opens it with the scheme default
     *
     * @param {string} uri - Currently http(s) and tel: URIs are supported
     */
    shareUri(uri) {
        switch (true) {
            // Currently only pass http(s)/tel URIs
            case uri.startsWith('http://'):
            case uri.startsWith('https://'):
            case uri.startsWith('tel:'):
                break;

            // Redirect local file URIs
            case uri.startsWith('file://'):
                return this.sendFile(uri);

            // Assume HTTPS
            default:
                uri = `https://${uri}`;
        }

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.share.request',
            body: { url: uri }
        });
    }
});


/** A simple FileChooserDialog for sharing files */
var FileChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectShareFileChooserDialog',
}, class FileChooserDialog extends Gtk.FileChooserDialog {

    _init(device) {
        super._init({
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _('Send files to %s').format(device.name),
            select_multiple: true
        });
        this.device = device;

        this._uriEntry = new Gtk.Entry({
            placeholder_text: 'https://',
            hexpand: true,
            visible: true
        });
        this._uriEntry.connect('activate', this._sendLink.bind(this));

        this._uriButton = new Gtk.ToggleButton({
            image: new Gtk.Image({
                icon_name: 'web-browser-symbolic',
                pixel_size: 16
            }),
            // TRANSLATORS: eg. Send a link to Google Pixel
            tooltip_text: _('Send a link to %s').format(device.name),
            visible: true
        });
        this._uriButton.connect('toggled', this._onUriButtonToggled.bind(this));

        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        let sendButton = this.add_button(_('Send'), Gtk.ResponseType.OK);
        sendButton.connect('clicked', this._sendLink.bind(this));

        this.get_header_bar().pack_end(this._uriButton);
        this.set_default_response(Gtk.ResponseType.OK);
        this.connect('delete-event', () => this.response(Gtk.ResponseType.CANCEL));
    }

    _onUriButtonToggled(button) {
        let header = this.get_header_bar();

        if (button.active) {
            header.set_custom_title(this._uriEntry);
            this.set_response_sensitive(Gtk.ResponseType.OK, true);
        } else {
            header.set_custom_title(null);
            this.set_response_sensitive(
                Gtk.ResponseType.OK,
                this.get_uris().length > 1
            );
        }
    }

    _sendLink(widget) {
        if (this._uriButton.active && this._uriEntry.text.length) {
            this.response(1);
        }
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            this.get_uris().map(uri => {
                let parameter = new GLib.Variant('s', uri);
                this.device.activate_action('shareFile', parameter);
            });
        } else if (response_id === 1) {
            let parameter = new GLib.Variant('s', this._uriEntry.text);
            this.device.activate_action('shareUri', parameter);
        }

        this.destroy();
    }
});

