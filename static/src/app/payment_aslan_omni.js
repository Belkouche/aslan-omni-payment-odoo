/** @odoo-module **/

import { PaymentInterface } from '@point_of_sale/app/utils/payment/payment_interface';
import { registry } from '@web/core/registry';
import { AlertDialog } from '@web/core/confirmation_dialog/confirmation_dialog';

const PAYMENT_TIMEOUT_MS = 97000;  // 2s buffer over the API's 95s command TTL
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
     *
     * The server caps `ref`/`originalRef` at 40 chars (z.string().max(40)).
     * `line.uuid` alone (Odoo's uuidv4 for this payment line) is already
     * globally unique, so there is no need to also fold in the order's uuid —
     * stripping the dashes keeps it stable and deterministic while fitting
     * comfortably under the cap: 'ODOO-' + 32 hex chars = 37 chars.
     */
    _payRef(line) {
        return `ODOO-${line.uuid.replace(/-/g, '')}`;
    }

    /**
     * Called when cashier clicks "Charge" for Aslan Omni.
     * The Odoo server relays the payment to the Omni API (the merchant key never
     * reaches the POS) and returns the commandId at once; we then poll its status.
     * On a network failure before the command is known, the same ref is sent
     * again — the API returns the completed result, a 409 + commandId (then we
     * poll), or safely re-relays, so a retry never starts a second card read.
     */
    async sendPaymentRequest(line) {
        await super.sendPaymentRequest(...arguments);

        if (!line.payment_method_id.aslan_omni_device_id) {
            this._showError('Terminal Aslan Omni non configuré. Associez un terminal dans les paramètres.');
            return false;
        }

        const ref = this._payRef(line);
        line.uiState.aslanOmniRef = ref;

        line.setPaymentStatus('waitingCard');

        const cashier = this.pos.accessRight.cashier;
        const args = [
            ref,
            Math.round(line.amount * 100),
            String(cashier?.id || ''),
            String(this.pos.config.id),
            line.pos_order_id.name || line.pos_order_id.pos_reference || false,
        ];

        // Bounded so a persistent outage still ends.
        for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
            const res = await this._callOmni('aslan_omni_send_payment', args);
            if (res.error === 'network' && attempt < MAX_RECOVERY_ATTEMPTS) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                continue;
            }
            return this._handleCommandResponse(res, line, data => this._handleResult(data, line));
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

    /**
     * Turns the server's answer to a pay/reverse request into a line status.
     * `onResult` handles a final result, given directly or reached by polling.
     */
    async _handleCommandResponse(res, line, onResult) {
        if (res.error === 'not_configured') {
            this._showError('Terminal Aslan Omni non configuré. Associez un terminal dans les paramètres.');
            line.setPaymentStatus('retry');
            return false;
        }
        if (res.error) {
            this._showError('Erreur réseau. Vérifiez la connexion internet, puis relancez le paiement (la carte ne sera pas débitée deux fois).');
            line.setPaymentStatus('retry');
            return false;
        }
        const { httpStatus, body } = res;
        if (httpStatus === 503) {
            this._showError('Terminal non connecté. Vérifiez que le terminal Aslan Omni est allumé.');
            line.setPaymentStatus('retry');
            return false;
        }
        // 202 = relayed; 409 = this ref is already executing on the terminal.
        // Either way, follow the command; never start a parallel card read.
        if ((httpStatus === 202 || httpStatus === 409) && body.commandId) {
            return await this._pollForResult(body.commandId, line, onResult);
        }
        if (httpStatus === 408) {
            this._showError("Délai expiré. La carte n'a pas été lue à temps.");
            line.setPaymentStatus('retry');
            return false;
        }
        if (httpStatus < 200 || httpStatus >= 300) {
            this._showError(`Erreur serveur: ${body.errorDescription || body.error || httpStatus}`);
            line.setPaymentStatus('retry');
            return false;
        }
        // 200 — the ref already had a final result.
        return onResult(body);
    }

    async _pollForResult(commandId, line, onResult) {
        // Outlasts the API's 95s command TTL, so the last poll sees the timeout.
        const deadline = Date.now() + PAYMENT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            const res = await this._callOmni('aslan_omni_command_status', [commandId]);
            if (res.error || res.httpStatus !== 200) continue;  // hiccup — keep polling
            const data = res.body;
            if (data.status === 'completed') {
                return onResult({ ...data, status: data.resultStatus });
            }
            if (data.status === 'timeout') {
                this._showError("Délai expiré. La carte n'a pas été lue à temps.");
                line.setPaymentStatus('retry');
                return false;
            }
            // status === 'pending' — keep polling
        }
        this._showError('Délai expiré.');
        line.setPaymentStatus('retry');
        return false;
    }

    /**
     * Called by Odoo POS when the cashier clicks "Reverse" on a paid order.
     * Relayed through the Odoo server to POST /cloud/reverse, then polled like a payment.
     */
    async sendReversal(line) {
        const result = line.uiState.aslanOmniResult;
        if (!result?.stan) {
            this._showError("Impossible d'annuler : données de transaction manquantes (STAN absent).");
            return false;
        }

        if (!line.payment_method_id.aslan_omni_device_id) {
            this._showError('Terminal Aslan Omni non configuré.');
            return false;
        }

        // originalRef must match the ref used in the original /cloud/pay call so
        // the server can tie the reversal to it. Fall back to the stable scheme
        // (same as _payRef) when the stored ref is somehow missing.
        const originalRef = line.uiState.aslanOmniRef || this._payRef(line);
        // The reversal's OWN ref is also stable (no Date.now()) and distinct from
        // originalRef (different prefix, so it can never collide with it in the
        // server's unique `ref` column), derived straight from line.uuid rather
        // than wrapping originalRef — 'REV-' + ODOO-'s payload would exceed the
        // 40-char cap. The server only requires ref to be unique and originalRef
        // to resolve to the prior command; it does not require ref === 'REV-' +
        // originalRef.
        const reverseRef = `REV-${line.uuid.replace(/-/g, '')}`;

        line.setPaymentStatus('waitingCard');

        const res = await this._callOmni('aslan_omni_send_reversal', [reverseRef, originalRef, result.stan]);
        return this._handleCommandResponse(res, line, data => {
            if (data.status === 'reversed') {
                line.setPaymentStatus('done');
                return true;
            }
            this._showError(`Annulation refusée (statut: ${data.status}).`);
            line.setPaymentStatus('retry');
            return false;
        });
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
                acquirerMerchantId: data.acquirerMerchantId,
                acquirerTerminalId: data.acquirerTerminalId,
                transactionNumber:  data.transactionNumber,
                // Header/amount of the card slips printed with the order receipt.
                companyName: this.pos.company.name,
                amount:      this.pos.formatCurrency(line.amount),
                orderName:   line.pos_order_id.name || '',
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

    /**
     * Calls an aslan_omni_* method of this payment method on the Odoo server.
     * Returns its {httpStatus, body} or {error}; an unreachable Odoo is a network error.
     */
    async _callOmni(method, args) {
        try {
            return await this.env.services.orm.silent.call(
                'pos.payment.method', method, [[this.payment_method_id.id], ...args],
            );
        } catch (_err) {
            return { error: 'network' };
        }
    }
}

// Register with the payment-provider registry. The key 'aslan_omni' must match
// the payment_provider value declared in models/pos_payment_method.py.
registry.category('pos_payment_providers').add('aslan_omni', PaymentAslanOmni);
