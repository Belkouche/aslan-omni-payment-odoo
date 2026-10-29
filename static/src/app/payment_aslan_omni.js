/** @odoo-module **/

import { PaymentInterface } from '@point_of_sale/app/utils/payment/payment_interface';
import { registry } from '@web/core/registry';
import { AlertDialog } from '@web/core/confirmation_dialog/confirmation_dialog';

const PAYMENT_TIMEOUT_MS = 97000;  // 2s buffer over server's 95s long-poll
const POLL_INTERVAL_MS   = 3000;
const MAX_RECOVERY_ATTEMPTS = 2;   // re-POSTs after the first, before giving up

export class PaymentAslanOmni extends PaymentInterface {

    /**
     * Stable idempotency key for a payment line.
     *
     * CRITICAL: this must NOT contain a timestamp or any value that changes
     * between attempts. The server (POST /cloud/pay) keys its entire dedup and
     * recovery logic on `ref` — re-POSTing the SAME ref returns the existing
     * result instead of starting a second card read. A ref that changed each
     * attempt (e.g. with Date.now()) would make every retry a NEW command and
     * reopen a double-charge window. `line.uuid` is Odoo's stable, per-line
     * client id, so one physical payment line always maps to one ref.
     */
    _payRef(line) {
        return `ODOO-${line.pos_order_id.uuid}-${line.uuid}`;
    }

    /**
     * Called when cashier clicks "Charge" for Aslan Omni.
     * POSTs to /cloud/pay (long-poll, holds up to 95s). On ANY failure before a
     * result is known, it re-POSTs with the SAME ref — the server returns the
     * completed result, a 409 + commandId (then we poll), or safely re-relays.
     * This recovery covers a drop during the initial long-poll too, where the
     * older "poll only if we already have a commandId" approach gave up blindly.
     */
    async sendPaymentRequest(line) {
        await super.sendPaymentRequest(...arguments);

        const paymentMethod = line.payment_method_id;
        const apiUrl   = paymentMethod.aslan_omni_api_url || 'https://api.aslanpay.ma';
        const apiKey   = paymentMethod.aslan_omni_api_key;
        const deviceId = paymentMethod.aslan_omni_device_id;

        if (!apiKey || !deviceId) {
            this._showError('Terminal Aslan Omni non configuré. Associez un terminal dans les paramètres.');
            return false;
        }
        if (!apiUrl.startsWith('https://')) {
            this._showError('Aslan Omni API URL must use HTTPS. Check the payment method configuration.');
            return false;
        }

        const amountCents = Math.round(line.amount * 100);
        const ref = this._payRef(line);
        line.uiState.aslanOmniRef = ref;

        line.setPaymentStatus('waitingCard');

        const cashier = this.pos.accessRight.cashier;
        const payload = JSON.stringify({
            ref,
            amountCents,
            cashierId: String(cashier?.id || ''),
            tillId: String(this.pos.config.id),
            description: line.pos_order_id.name,
        });

        // Attempt the long-poll; on a network failure, re-POST the same ref so
        // the server re-attaches us to the in-flight/completed command rather
        // than starting a new one. Bounded so a persistent outage still ends.
        for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
            try {
                const resp = await this._fetchWithTimeout(`${apiUrl}/cloud/pay`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: payload,
                }, PAYMENT_TIMEOUT_MS);

                if (resp.status === 503) {
                    this._showError('Terminal non connecté. Vérifiez que le terminal Aslan Omni est allumé.');
                    line.setPaymentStatus('retry');
                    return false;
                }

                const data = await resp.json();

                // 409 = this ref is already executing on the terminal. Attach to
                // it by polling its status; never start a parallel card read.
                if (resp.status === 409 && data.commandId) {
                    return await this._pollForResult(apiUrl, apiKey, data.commandId, line);
                }

                if (!resp.ok) {
                    this._showError(`Erreur serveur: ${data.error || resp.status}`);
                    line.setPaymentStatus('retry');
                    return false;
                }

                // 200 — the long-poll returned the terminal's final result.
                return this._handleResult(data, line);

            } catch (_err) {
                // Network dropped. We may or may not have a commandId — it does
                // not matter: re-POSTing the SAME ref is the recovery path the
                // server is built for. Keep the UI in waitingCard and retry.
                if (attempt < MAX_RECOVERY_ATTEMPTS) {
                    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                    continue;
                }
                this._showError('Erreur réseau. Vérifiez la connexion internet, puis relancez le paiement (la carte ne sera pas débitée deux fois).');
                line.setPaymentStatus('retry');
                return false;
            }
        }
        return false;
    }

    async sendPaymentCancel(line) {
        // IMPORTANT: there is no server-side abort. Once /cloud/pay has relayed
        // the command, the terminal is reading a card and only the terminal (its
        // own back button / timeout) can stop it. From Odoo we can only reset the
        // POS UI — we CANNOT guarantee the terminal stopped.
        //
        // This is safe against double-charging ONLY because the ref is stable
        // (_payRef): if the cashier re-charges the same line, /cloud/pay sees the
        // same ref and re-attaches to the existing command instead of starting a
        // second card read. We warn the cashier so they verify the terminal.
        super.sendPaymentCancel(...arguments);
        line.setPaymentStatus('retry');
        this._showError(
            "Annulation côté caisse uniquement. Si le terminal demande encore la carte, "
            + "annulez AUSSI sur le terminal (bouton retour). Relancer le paiement ne débite pas deux fois.",
        );
        return true;
    }

    async _pollForResult(apiUrl, apiKey, commandId, line) {
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
                    return this._handleResult({ ...data, status: data.resultStatus }, line);
                }
                if (data.status === 'timeout') {
                    this._showError("Délai expiré. La carte n'a pas été lue à temps.");
                    line.setPaymentStatus('retry');
                    return false;
                }
                // status === 'pending' — keep polling
            } catch (_) { /* network hiccup — keep polling */ }
        }
        this._showError('Délai expiré.');
        line.setPaymentStatus('retry');
        return false;
    }

    /**
     * Called by Odoo POS when the cashier clicks "Reverse" on a paid order.
     * Uses POST /cloud/reverse (merchant auth, same long-poll pattern as /cloud/pay).
     */
    async sendReversal(line) {
        const result = line.uiState.aslanOmniResult;
        if (!result?.stan) {
            this._showError("Impossible d'annuler : données de transaction manquantes (STAN absent).");
            return false;
        }

        const paymentMethod = line.payment_method_id;
        const apiUrl   = paymentMethod.aslan_omni_api_url || 'https://api.aslanpay.ma';
        const apiKey   = paymentMethod.aslan_omni_api_key;
        const deviceId = paymentMethod.aslan_omni_device_id;

        if (!apiKey || !deviceId) {
            this._showError('Terminal Aslan Omni non configuré.');
            return false;
        }

        // originalRef must match the ref used in the original /cloud/pay call so
        // the server can tie the reversal to it. Fall back to the stable scheme
        // (same as _payRef) when the stored ref is somehow missing.
        const originalRef = line.uiState.aslanOmniRef || this._payRef(line);
        // The reversal's OWN ref is also stable (no Date.now()): the server keys
        // /cloud/reverse dedup on ref too, so retrying a dropped reversal must
        // reuse the same ref to avoid issuing a second void.
        const reverseRef  = `REV-${originalRef}`;

        line.setPaymentStatus('waitingCard');

        try {
            const resp = await this._fetchWithTimeout(`${apiUrl}/cloud/reverse`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'X-Device-Id': deviceId,
                },
                body: JSON.stringify({
                    ref: reverseRef,
                    originalRef,
                    stan: result.stan,
                }),
            }, PAYMENT_TIMEOUT_MS);

            if (resp.status === 503) {
                this._showError('Terminal non connecté.');
                line.setPaymentStatus('retry');
                return false;
            }

            const data = await resp.json();

            if (!resp.ok) {
                this._showError(`Erreur annulation: ${data.error || resp.status}`);
                line.setPaymentStatus('retry');
                return false;
            }

            if (data.status === 'reversed') {
                line.setPaymentStatus('done');
                return true;
            }

            this._showError(`Annulation refusée (statut: ${data.status}).`);
            line.setPaymentStatus('retry');
            return false;

        } catch (_err) {
            this._showError('Erreur réseau lors de l\'annulation.');
            line.setPaymentStatus('retry');
            return false;
        }
    }

    _handleResult(data, line) {
        if (data.status === 'approved') {
            line.setPaymentStatus('done');
            line.uiState.aslanOmniResult = {
                // Enforce masking defensively — never store/display a full PAN.
                cardNumber:  this._maskPan(data.cardNumber),
                cardScheme:  data.cardScheme,
                authNumber:  data.authNumber,
                rrn:         data.rrn,
                stan:        data.stan,
                txDate:      data.txDate,
                txTime:      data.txTime,
            };
            return true;
        }
        if (data.status === 'reversed') {
            line.setPaymentStatus('done');
            return true;
        }
        if (data.status === 'cancelled') {
            this._showError('Paiement annulé par le client.');
            line.setPaymentStatus('retry');
            return false;
        }
        if (data.status === 'timeout') {
            this._showError("Délai expiré. La carte n'a pas été lue à temps.");
            line.setPaymentStatus('retry');
            return false;
        }
        // declined
        const rc = data.responseCode ? ` (RC: ${data.responseCode})` : '';
        this._showError(`Paiement refusé${rc}.`);
        line.setPaymentStatus('retry');
        return false;
    }

    _maskPan(pan) {
        if (!pan || typeof pan !== 'string') return '';
        // Keep only last 4 digits visible; replace all preceding digits with *.
        return pan.replace(/\d(?=\d{4})/g, '*');
    }

    _showError(msg) {
        this.dialog.add(AlertDialog, { title: 'Aslan Omni', body: msg });
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

// Register with the payment-provider registry. The key 'aslan_omni' must match
// the payment_provider value declared in models/pos_payment_method.py.
registry.category('pos_payment_providers').add('aslan_omni', PaymentAslanOmni);
