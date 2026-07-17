/** @odoo-module **/

import { Component, useState, useRef } from '@odoo/owl';
import { registry } from '@web/core/registry';
import { useService } from '@web/core/utils/hooks';

export class AslanOmniPairingWidget extends Component {
    setup() {
        this.orm = useService('orm');
        this.state = useState({ step: 'idle', code: '', deviceId: '', errorMsg: '' });
        this.codeInput = useRef('codeInput');
    }

    onCodeInput(ev) {
        this.state.code = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        ev.target.value = this.state.code;
    }

    async onSubmitCode() {
        const code = this.state.code;
        if (code.length !== 8) return;

        const configId = this.props.record.resId;
        const [config] = await this.orm.read('pos.config', [configId], ['aslan_omni_api_url']);
        const apiUrl = config.aslan_omni_api_url || 'https://api.aslanpay.ma';

        if (!apiUrl.startsWith('https://')) {
            this.state.step = 'error';
            this.state.errorMsg = "L'URL de l'API doit utiliser HTTPS.";
            return;
        }

        this.state.step = 'loading';
        try {
            const resp = await fetch(`${apiUrl}/cloud/pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pairingCode: code }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                this.state.step = 'error';
                this.state.errorMsg = data.error || `Erreur ${resp.status}`;
                return;
            }
            await this.orm.write('pos.config', [configId], {
                aslan_omni_device_id: data.deviceId,
                aslan_omni_api_key: data.apiKey,
            });
            this.state.deviceId = data.deviceId;
            this.state.step = 'done';
        } catch (_err) {
            this.state.step = 'error';
            this.state.errorMsg = 'Erreur réseau. Vérifiez la connexion.';
        }
    }

    reset() {
        Object.assign(this.state, { step: 'idle', code: '', errorMsg: '' });
    }
}

AslanOmniPairingWidget.template = 'aslan_omni.PairingWidget';
AslanOmniPairingWidget.props = {
    record: { type: Object },
    readonly: { type: Boolean, optional: true },
    id: { type: String, optional: true },
};

registry.category('fields').add('aslan_omni_pairing', {
    component: AslanOmniPairingWidget,
    displayName: 'Aslan Omni Pairing',
    supportedTypes: ['char'],
});
