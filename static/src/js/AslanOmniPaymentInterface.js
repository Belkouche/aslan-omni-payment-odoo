/** @odoo-module **/

import { AbstractPaymentInterface } from 'point_of_sale.payment';
import { registry } from '@web/core/registry';

const PAYMENT_TIMEOUT_MS = 97000;  // 2s buffer over server's 95s long-poll
const POLL_INTERVAL_MS   = 3000;

export class AslanOmniPaymentInterface extends AbstractPaymentInterface {

    /**
     * Called when cashier clicks "Charge" for Aslan Omni.
     * POSTs to /cloud/pay (long-poll, holds up to 95s),
     * falls back to polling /cloud/pay/:id/status if connection drops.
     */
    async sendPaymentRequest(order) {
        const paymentLine = order.selected_paymentline;
        if (!paymentLine) return false;

        const config  = this.pos.config;
        const apiUrl  = config.aslan_omni_api_url || 'https://api.aslanpay.ma';
        const apiKey  = config.aslan_omni_api_key;
        const deviceId = config.aslan_omni_device_id;

        if (!apiKey || !deviceId) {
            this._showError('Terminal Aslan Omni non configuré. Associez un terminal dans les paramètres.');
            return false;
        }

        const amountCents = Math.round(paymentLine.amount * 100);
        const ref = `ODOO-${order.uid}-${Date.now()}`;

        paymentLine.set_payment_status('waitingCard');

        let commandId = null;
        try {
            const resp = await this._fetchWithTimeout(`${apiUrl}/cloud/pay`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    ref,
                    amountCents,
                    cashierId: String(this.pos.cashier?.id || ''),
                    tillId: String(config.id),
                    description: order.name,
                }),
            }, PAYMENT_TIMEOUT_MS);

            if (resp.status === 503) {
                this._showError('Terminal non connecté. Vérifiez que le terminal Aslan Omni est allumé.');
                paymentLine.set_payment_status('retry');
                return false;
            }

            const data = await resp.json();

            if (resp.status === 409 && data.commandId) {
                // Payment already in progress — poll for result
                commandId = data.commandId;
                return await this._pollForResult(apiUrl, apiKey, commandId, paymentLine);
            }

            if (!resp.ok) {
                this._showError(`Erreur serveur: ${data.error || resp.status}`);
                paymentLine.set_payment_status('retry');
                return false;
            }

            // commandId from the response body (for receipt / status endpoint)
            commandId = data.commandId;
            return this._handleResult(data, paymentLine);

        } catch (err) {
            // Network error mid-long-poll — fall back to polling if we know the commandId
            if (commandId) {
                return await this._pollForResult(apiUrl, apiKey, commandId, paymentLine);
            }
            this._showError('Erreur réseau. Vérifiez la connexion internet.');
            paymentLine.set_payment_status('retry');
            return false;
        }
    }

    async sendPaymentCancel(order, uuid) {
        // NapsPay cancellation is terminal-side only (back button on terminal).
        // From Odoo we cannot abort mid-flight — just reset UI.
        const paymentLine = order.selected_paymentline;
        if (paymentLine) paymentLine.set_payment_status('retry');
        return true;
    }

    async _pollForResult(apiUrl, apiKey, commandId, paymentLine) {
        const deadline = Date.now() + PAYMENT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            try {
                const resp = await fetch(`${apiUrl}/cloud/pay/${commandId}/status`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                });
                if (!resp.ok) continue;
                const data = await resp.json();
                if (data.status === 'completed') {
                    return this._handleResult({ ...data, status: data.resultStatus }, paymentLine);
                }
                if (data.status === 'timeout') {
                    this._showError("Délai expiré. La carte n'a pas été lue à temps.");
                    paymentLine.set_payment_status('retry');
                    return false;
                }
                // status === 'pending' — keep polling
            } catch (_) { /* network hiccup — keep polling */ }
        }
        this._showError('Délai expiré.');
        paymentLine.set_payment_status('retry');
        return false;
    }

    _handleResult(data, paymentLine) {
        if (data.status === 'approved') {
            paymentLine.set_payment_status('done');
            paymentLine.aslan_omni_result = {
                cardNumber:  data.cardNumber,
                cardScheme:  data.cardScheme,
                authNumber:  data.authNumber,
                rrn:         data.rrn,
                stan:        data.stan,
                txDate:      data.txDate,
                txTime:      data.txTime,
            };
            return true;
        }
        if (data.status === 'cancelled') {
            this._showError('Paiement annulé par le client.');
            paymentLine.set_payment_status('retry');
            return false;
        }
        if (data.status === 'timeout') {
            this._showError("Délai expiré. La carte n'a pas été lue à temps.");
            paymentLine.set_payment_status('retry');
            return false;
        }
        // declined
        const rc = data.responseCode ? ` (RC: ${data.responseCode})` : '';
        this._showError(`Paiement refusé${rc}.`);
        paymentLine.set_payment_status('retry');
        return false;
    }

    _showError(msg) {
        this.pos.env.services.popup.add(
            this.pos.env.services.popup.components.ErrorPopup,
            { title: 'Aslan Omni', body: msg },
        );
    }

    async _fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }
}

// Register with the payment method registry.
// The key 'aslan_omni' must match the use_payment_terminal value on pos.payment.method.
registry.category('payment_method').add('aslan_omni', AslanOmniPaymentInterface);
