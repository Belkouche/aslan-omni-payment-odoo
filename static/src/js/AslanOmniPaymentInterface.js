/** @odoo-module **/

import { AbstractPaymentInterface } from '@point_of_sale/payment';
import { registry } from '@web/core/registry';
import { AlertDialog } from '@web/core/confirmation_dialog/confirmation_dialog';
import { useService } from '@web/core/utils/hooks';

const PAYMENT_TIMEOUT_MS = 97000;  // 2s buffer over server's 95s long-poll
const POLL_INTERVAL_MS   = 3000;
const MAX_RECOVERY_ATTEMPTS = 2;   // re-POSTs after the first, before giving up

export class AslanOmniPaymentInterface extends AbstractPaymentInterface {

    setup() {
        super.setup(...arguments);
        this.dialog = useService('dialog');
    }

    /**
     * Stable idempotency key for a payment line.
     *
     * CRITICAL: this must NOT contain a timestamp or any value that changes
     * between attempts. The server (POST /cloud/pay) keys its entire dedup and
     * recovery logic on `ref` — re-POSTing the SAME ref returns the existing
     * result instead of starting a second card read. A ref that changed each
     * attempt (e.g. with Date.now()) would make every retry a NEW command and
     * reopen a double-charge window. `paymentLine.cid` is Odoo's stable,
     * per-line client id, so one physical payment line always maps to one ref.
     */
    _payRef(order, paymentLine) {
        return `ODOO-${order.uid}-${paymentLine.cid}`;
    }

    /**
     * Called when cashier clicks "Charge" for Aslan Omni.
     * POSTs to /cloud/pay (long-poll, holds up to 95s). On ANY failure before a
     * result is known, it re-POSTs with the SAME ref — the server returns the
     * completed result, a 409 + commandId (then we poll), or safely re-relays.
     * This recovery covers a drop during the initial long-poll too, where the
     * older "poll only if we already have a commandId" approach gave up blindly.
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
        if (!apiUrl.startsWith('https://')) {
            this._showError('Aslan Omni API URL must use HTTPS. Check POS configuration.');
            return false;
        }

        const amountCents = Math.round(paymentLine.amount * 100);
        const ref = this._payRef(order, paymentLine);
        paymentLine.aslan_omni_ref = ref;

        paymentLine.set_payment_status('waitingCard');

        const cashier = this.pos.get_cashier ? this.pos.get_cashier() : this.pos.cashier;
        const payload = JSON.stringify({
            ref,
            amountCents,
            cashierId: String(cashier?.id || ''),
            tillId: String(config.id),
            description: order.name,
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
                    paymentLine.set_payment_status('retry');
                    return false;
                }

                const data = await resp.json();

                // 409 = this ref is already executing on the terminal. Attach to
                // it by polling its status; never start a parallel card read.
                if (resp.status === 409 && data.commandId) {
                    return await this._pollForResult(apiUrl, apiKey, data.commandId, paymentLine, ref);
                }

                if (!resp.ok) {
                    this._showError(`Erreur serveur: ${data.error || resp.status}`);
                    paymentLine.set_payment_status('retry');
                    return false;
                }

                // 200 — the long-poll returned the terminal's final result.
                return this._handleResult(data, paymentLine, ref);

            } catch (_err) {
                // Network dropped. We may or may not have a commandId — it does
                // not matter: re-POSTing the SAME ref is the recovery path the
                // server is built for. Keep the UI in waitingCard and retry.
                if (attempt < MAX_RECOVERY_ATTEMPTS) {
                    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                    continue;
                }
                this._showError('Erreur réseau. Vérifiez la connexion internet, puis relancez le paiement (la carte ne sera pas débitée deux fois).');
                paymentLine.set_payment_status('retry');
                return false;
            }
        }
        return false;
    }

    async sendPaymentCancel(order, uuid) {
        // IMPORTANT: there is no server-side abort. Once /cloud/pay has relayed
        // the command, the terminal is reading a card and only the terminal (its
        // own back button / timeout) can stop it. From Odoo we can only reset the
        // POS UI — we CANNOT guarantee the terminal stopped.
        //
        // This is safe against double-charging ONLY because the ref is stable
        // (_payRef): if the cashier re-charges the same line, /cloud/pay sees the
        // same ref and re-attaches to the existing command instead of starting a
        // second card read. We warn the cashier so they verify the terminal.
        const paymentLine = order.selected_paymentline;
        if (paymentLine) paymentLine.set_payment_status('retry');
        this._showError(
            "Annulation côté caisse uniquement. Si le terminal demande encore la carte, "
            + "annulez AUSSI sur le terminal (bouton retour). Relancer le paiement ne débite pas deux fois.",
        );
        return true;
    }

    async _pollForResult(apiUrl, apiKey, commandId, paymentLine, ref) {
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
                    return this._handleResult({ ...data, status: data.resultStatus }, paymentLine, null);
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

    /**
     * Called by Odoo POS when the cashier clicks "Reverse" on a paid order.
     * Uses POST /cloud/reverse (merchant auth, same long-poll pattern as /cloud/pay).
     */
    async sendReversal(order) {
        const paymentLine = order.selected_paymentline;
        if (!paymentLine) return false;

        const result = paymentLine.aslan_omni_result;
        if (!result?.stan) {
            this._showError("Impossible d'annuler : données de transaction manquantes (STAN absent).");
            return false;
        }

        const config   = this.pos.config;
        const apiUrl   = config.aslan_omni_api_url || 'https://api.aslanpay.ma';
        const apiKey   = config.aslan_omni_api_key;
        const deviceId = config.aslan_omni_device_id;

        if (!apiKey || !deviceId) {
            this._showError('Terminal Aslan Omni non configuré.');
            return false;
        }

        // originalRef must match the ref used in the original /cloud/pay call so
        // the server can tie the reversal to it. Fall back to the stable scheme
        // (same as _payRef) when the stored ref is somehow missing.
        const originalRef = paymentLine.aslan_omni_ref || this._payRef(order, paymentLine);
        // The reversal's OWN ref is also stable (no Date.now()): the server keys
        // /cloud/reverse dedup on ref too, so retrying a dropped reversal must
        // reuse the same ref to avoid issuing a second void.
        const reverseRef  = `REV-${originalRef}`;

        paymentLine.set_payment_status('waitingCard');

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
                paymentLine.set_payment_status('retry');
                return false;
            }

            const data = await resp.json();

            if (!resp.ok) {
                this._showError(`Erreur annulation: ${data.error || resp.status}`);
                paymentLine.set_payment_status('retry');
                return false;
            }

            if (data.status === 'reversed') {
                paymentLine.set_payment_status('done');
                return true;
            }

            this._showError(`Annulation refusée (statut: ${data.status}).`);
            paymentLine.set_payment_status('retry');
            return false;

        } catch (_err) {
            this._showError('Erreur réseau lors de l\'annulation.');
            paymentLine.set_payment_status('retry');
            return false;
        }
    }

    _handleResult(data, paymentLine, ref) {
        if (data.status === 'approved') {
            paymentLine.set_payment_status('done');
            paymentLine.aslan_omni_ref = ref;
            paymentLine.aslan_omni_result = {
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
            paymentLine.set_payment_status('done');
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

// Register with the payment method registry.
// The key 'aslan_omni' must match the use_payment_terminal value on pos.payment.method.
registry.category('payment_method').add('aslan_omni', AslanOmniPaymentInterface);
