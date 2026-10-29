/** @odoo-module **/

import { Component, useState, useRef } from '@odoo/owl';
import { registry } from '@web/core/registry';
import { useService } from '@web/core/utils/hooks';

export class AslanOmniPairingWidget extends Component {
    setup() {
        this.orm = useService('orm');
        // Pre-populate deviceId from the record so the "paired" state shows on load.
        const existingDeviceId = this.props.record.data?.aslan_omni_device_id || '';
        this.state = useState({
            step: existingDeviceId ? 'done' : 'idle',
            code: '',
            deviceId: existingDeviceId,
            errorMsg: '',
        });
        this.codeInput = useRef('codeInput');
    }

    onCodeInput(ev) {
        this.state.code = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        ev.target.value = this.state.code;
    }

    async onSubmitCode() {
        const code = this.state.code;
        if (code.length !== 8) return;

        const resId = this.props.record.resId;
        const [paymentMethod] = await this.orm.read('pos.payment.method', [resId], ['aslan_omni_api_url']);
        const apiUrl = paymentMethod.aslan_omni_api_url || 'https://api.aslanpay.ma';

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
            await this.orm.write('pos.payment.method', [resId], {
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

    async onRevoke() {
        if (!confirm('Dissocier ce terminal Aslan Omni ? Le terminal devra être réassocié pour accepter des paiements depuis Odoo.')) return;

        const resId = this.props.record.resId;
        const [paymentMethod] = await this.orm.read('pos.payment.method', [resId], [
            'aslan_omni_api_url', 'aslan_omni_api_key', 'aslan_omni_device_id',
        ]);
        const apiUrl   = paymentMethod.aslan_omni_api_url   || 'https://api.aslanpay.ma';
        const apiKey   = paymentMethod.aslan_omni_api_key;
        const deviceId = paymentMethod.aslan_omni_device_id;

        this.state.step = 'revoking';
        try {
            // Merchant-side revoke — requires apiKey auth, targets the specific device.
            // Best-effort: always clear locally even if the request fails.
            if (apiKey && deviceId) {
                await fetch(`${apiUrl}/cloud/devices/${deviceId}/revoke`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: '{}',
                }).catch(() => {});
            }
        } finally {
            // Always clear local fields regardless of network outcome.
            await this.orm.write('pos.payment.method', [resId], {
                aslan_omni_device_id: false,
                aslan_omni_api_key: false,
            });
            Object.assign(this.state, { step: 'idle', code: '', deviceId: '', errorMsg: '' });
        }
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
