/** @odoo-module **/

import { PaymentInterface } from '@point_of_sale/app/utils/payment/payment_interface';
import { registry } from '@web/core/registry';
import { AlertDialog, ConfirmationDialog } from '@web/core/confirmation_dialog/confirmation_dialog';

const PAYMENT_TIMEOUT_MS = 97000;  // 2s buffer over the API's 95s command TTL
const POLL_INTERVAL_MS   = 3000;
const MAX_RECOVERY_ATTEMPTS = 2;   // re-POSTs after the first, before giving up
const NOT_DELIVERED_WARN_MS = 10000;

/** Errors worth re-POSTing the same ref for: the request may or may not have reached the API. */
const RETRYABLE_ERRORS = ['network', 'api_unreachable'];

const MSG_NOT_CONFIGURED = 'Terminal Aslan Omni non configuré. Associez un terminal dans les paramètres.';
const MSG_ODOO_LOST      = 'Connexion au serveur Odoo perdue. Relancez le paiement (pas de double débit).';
const MSG_API_LOST       = "Le serveur Odoo n'arrive pas à joindre Aslan. Relancez le paiement (pas de double débit).";
const MSG_UNCERTAIN      = 'Résultat incertain — vérifiez le terminal avant de relancer (relancer ne débite pas deux fois).';
const MSG_REV_UNKNOWN    = "Résultat de l'annulation inconnu — vérifiez sur le terminal.";

export class PaymentAslanOmni extends PaymentInterface {

    setup() {
        super.setup(...arguments);
        /**
         * One session per payment line (keyed by line.uuid) for the request in
         * flight. Cancel marks it cancelled and wakes its poll loop, so the loop
         * stops touching the line; a new Charge replaces it.
         */
        this._sessions = new Map();
    }

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
     */
    async sendPaymentRequest(line) {
        await super.sendPaymentRequest(...arguments);

        if (!line.payment_method_id.aslan_omni_device_id) {
            this._showError(MSG_NOT_CONFIGURED);
            return false;
        }

        const ref = this._payRef(line);
        line.uiState.aslanOmniRef = ref;
        line.setPaymentStatus('waitingCard');
        return this._sendPayment(line, false);
    }

    /**
     * POSTs the payment (same ref every time) and follows it to a result.
     *
     * On a network failure before the command is known — browser↔Odoo
     * ('network') or Odoo↔API ('api_unreachable') — the same ref is sent
     * again: the API returns the completed result, a 409 + commandId (then we
     * poll), or safely re-relays, so a retry never starts a second card read.
     *
     * `force` is only set after the cashier confirmed an uncertain result; it
     * asks the API to re-arm a ref whose stored outcome is unknown. An API that
     * does not know `force` ignores it and returns the stored result.
     */
    async _sendPayment(line, force) {
        const session = { cancelled: false, wake: null };
        this._sessions.set(line.uuid, session);

        const cashier = this.pos.accessRight.cashier;
        const args = [
            line.uiState.aslanOmniRef,
            Math.round(line.amount * 100),
            String(cashier?.id || ''),
            String(this.pos.config.id),
            line.pos_order_id.name || line.pos_order_id.pos_reference || false,
        ];
        const kwargs = force ? { force: true } : {};

        // Bounded so a persistent outage still ends.
        for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
            const res = await this._callOmni('aslan_omni_send_payment', args, kwargs);
            if (session.cancelled) {
                // Cancelled while the request was in flight: leave the line alone,
                // but keep watching the command in case the terminal approves it.
                if (res.body?.commandId) {
                    this._watchAfterCancel(res.body.commandId, line, session, Date.now() + PAYMENT_TIMEOUT_MS);
                }
                return false;
            }
            if (RETRYABLE_ERRORS.includes(res.error) && attempt < MAX_RECOVERY_ATTEMPTS) {
                await this._sleep(POLL_INTERVAL_MS, session);
                if (session.cancelled) return false;
                continue;
            }
            return this._handleCommandResponse(res, line, session, 'pay', data => this._handleResult(data, line, session));
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
        //
        // The running poll loop is woken and stops touching the line; a detached
        // watcher keeps following the command and tells the cashier if the
        // terminal approves it after all (see _watchAfterCancel).
        const session = this._sessions.get(line.uuid);
        if (session) {
            session.cancelled = true;
            session.wake?.();
        }
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
     * `kind` is 'pay' or 'reverse' (only changes the wording of an unknown outcome).
     */
    async _handleCommandResponse(res, line, session, kind, onResult) {
        if (res.error === 'not_configured') {
            this._showError(MSG_NOT_CONFIGURED);
            line.setPaymentStatus('retry');
            return false;
        }
        if (res.error) {
            this._showError(res.error === 'api_unreachable' ? MSG_API_LOST : MSG_ODOO_LOST);
            line.setPaymentStatus('retry');
            return false;
        }
        const { httpStatus } = res;
        const body = res.body || {};
        if (httpStatus === 503) {
            const seen = this._minutesAgo(body.lastSeenAt);
            this._showError(seen === null
                ? 'Terminal non connecté. Vérifiez que le terminal Aslan Omni est allumé.'
                : `Terminal hors ligne — vu il y a ${seen} min. Vérifiez qu'il est allumé et connecté.`);
            line.setPaymentStatus('retry');
            return false;
        }
        // SAFETY: a 409 WITHOUT a commandId (terminal_busy) is another ref's
        // payment on this terminal — never poll it, never attach to it.
        if (httpStatus === 409 && !body.commandId) {
            this._showError(body.code === 'terminal_busy'
                ? (body.error || 'Terminal occupé par un autre paiement.')
                : `Erreur serveur: ${body.errorDescription || body.error || httpStatus}`);
            line.setPaymentStatus('retry');
            return false;
        }
        // 202 = relayed; 409 + commandId = this ref is already executing on the
        // terminal. Either way, follow the command; never start a parallel card read.
        if ((httpStatus === 202 || httpStatus === 409) && body.commandId) {
            if (body.terminalState === 'reconnecting') {
                this._notify('Terminal en reconnexion…', 'info');
            }
            return await this._pollForResult(body.commandId, line, session, kind, onResult);
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

    async _pollForResult(commandId, line, session, kind, onResult) {
        // Outlasts the API's 95s command TTL, so the last poll sees the timeout.
        const startedAt = Date.now();
        const deadline = startedAt + PAYMENT_TIMEOUT_MS;
        let warnedUndelivered = false;
        let notedStarted = false;
        while (Date.now() < deadline) {
            await this._sleep(POLL_INTERVAL_MS, session);
            if (session.cancelled) {
                this._watchAfterCancel(commandId, line, session, deadline);
                return false;
            }
            const res = await this._callOmni('aslan_omni_command_status', [commandId]);
            if (session.cancelled) {
                this._watchAfterCancel(commandId, line, session, deadline);
                return false;
            }
            if (res.error || res.httpStatus !== 200) continue;  // hiccup — keep polling
            const data = res.body;
            if (data.status === 'completed') {
                return onResult({ ...data, status: data.resultStatus });
            }
            if (data.status === 'timeout') {
                return onResult({ ...data, status: 'timeout' });
            }
            // status === 'pending'. The progress fields only exist on newer APIs:
            // a missing key means "unknown", not "not delivered".
            if (!warnedUndelivered && 'deliveredAt' in data && data.deliveredAt == null
                    && Date.now() - startedAt >= NOT_DELIVERED_WARN_MS) {
                warnedUndelivered = true;
                this._notify("Le terminal n'a pas encore reçu la demande.", 'warning');
            }
            if (!notedStarted && data.stage === 'started') {
                notedStarted = true;
                this._notify('Paiement en cours sur le terminal.', 'info');
            }
        }
        // Deadline without a final result: one last look before giving up, so a
        // result that landed during the last interval is not reported as unknown.
        const last = await this._callOmni('aslan_omni_command_status', [commandId]);
        if (session.cancelled) return false;
        if (!last.error && last.httpStatus === 200 && last.body.status === 'completed') {
            return onResult({ ...last.body, status: last.body.resultStatus });
        }
        this._showError(kind === 'reverse' ? MSG_REV_UNKNOWN : MSG_UNCERTAIN);
        line.setPaymentStatus('retry');
        return false;
    }

    /**
     * After a cashier-side cancel, keeps following the command WITHOUT touching
     * the line. If the terminal approves it anyway, the cashier is told to
     * re-charge the line: the stable ref makes that re-charge attach to the
     * approved command (no second debit) and record it.
     * Stops as soon as a new Charge on the same line takes over.
     */
    async _watchAfterCancel(commandId, line, session, deadline) {
        while (Date.now() < deadline + POLL_INTERVAL_MS) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            if (this._sessions.get(line.uuid) !== session) return;
            const res = await this._callOmni('aslan_omni_command_status', [commandId]);
            if (this._sessions.get(line.uuid) !== session) return;
            if (res.error || res.httpStatus !== 200) continue;
            const data = res.body;
            if (data.status === 'completed' && data.resultStatus === 'approved') {
                this._notify('Le terminal a approuvé le paiement annulé — relancez la ligne pour l\'enregistrer.', 'warning', true);
                return;
            }
            if (data.status !== 'pending') return;
        }
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

        // A reversal is not cancellable from the POS: its session is never cancelled.
        const session = { cancelled: false, wake: null };
        const res = await this._callOmni('aslan_omni_send_reversal', [reverseRef, originalRef, result.stan]);
        return this._handleCommandResponse(res, line, session, 'reverse', data => {
            if (data.status === 'reversed') {
                line.setPaymentStatus('done');
                return true;
            }
            if (data.status === 'timeout' && !data.failure) {
                this._showError(MSG_REV_UNKNOWN);
            } else if (data.failure) {
                this._showError(data.failure.uncertain
                    ? `${MSG_REV_UNKNOWN} ${data.failure.message || ''}`.trim()
                    : this._failureText(data.failure));
            } else {
                this._showError(`Annulation refusée (statut: ${data.status}).`);
            }
            line.setPaymentStatus('retry');
            return false;
        });
    }

    async _handleResult(data, line, session) {
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
            if (data.resolvedLate) {
                this._notify('Paiement approuvé tardivement.', 'success');
            }
            return true;
        }
        if (data.status === 'reversed') {
            line.setPaymentStatus('done');
            return true;
        }

        // Not approved. A newer API explains why in `failure`; an older one does not.
        const failure = data.failure;
        if (failure?.uncertain) {
            // The outcome is unknown (e.g. NapsPay generic error): the cashier
            // must check the terminal. Only an explicit "relancer" re-arms the
            // command (force), still on the same ref.
            const retry = await this._confirm(
                'Résultat incertain',
                `${failure.message || 'Résultat incertain.'} Vérifiez le terminal. Relancer quand même ?`,
            );
            if (retry && !session.cancelled && this._sessions.get(line.uuid) === session) {
                line.setPaymentStatus('waitingCard');
                return this._sendPayment(line, true);
            }
            line.setPaymentStatus('retry');
            return false;
        }
        if (failure) {
            this._showError(this._failureText(failure));
        } else if (data.status === 'cancelled') {
            this._showError('Paiement annulé par le client.');
        } else if (data.status === 'timeout') {
            this._showError("Délai expiré. La carte n'a pas été lue à temps.");
        } else {
            // declined
            const rc = data.responseCode ? ` (RC: ${data.responseCode})` : '';
            this._showError(`Paiement refusé${rc}.`);
        }
        line.setPaymentStatus('retry');
        return false;
    }

    _failureText(failure) {
        return [failure.message, failure.cashierAction].filter(Boolean).join(' ') || 'Paiement refusé.';
    }

    _maskPan(pan) {
        if (!pan || typeof pan !== 'string') return '';
        // Keep only last 4 digits visible; replace all preceding digits with *.
        return pan.replace(/\d(?=\d{4})/g, '*');
    }

    /** Whole minutes since an ISO date, at least 1; null when absent/invalid. */
    _minutesAgo(iso) {
        const t = iso ? Date.parse(iso) : NaN;
        if (Number.isNaN(t)) return null;
        return Math.max(1, Math.round((Date.now() - t) / 60000));
    }

    /** Sleeps `ms`, or less if the session is cancelled meanwhile. */
    _sleep(ms, session) {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            session.wake = () => { clearTimeout(timer); resolve(); };
        });
    }

    _showError(msg) {
        this.dialog.add(AlertDialog, { title: 'Aslan Omni', body: msg });
    }

    /** Non-blocking message; `sticky` keeps it until dismissed. */
    _notify(msg, type = 'info', sticky = false) {
        this.env.services.notification.add(msg, { title: 'Aslan Omni', type, sticky });
    }

    /** Resolves true on confirm, false on cancel or when the dialog is closed. */
    _confirm(title, body) {
        return new Promise(resolve => {
            this.dialog.add(ConfirmationDialog, {
                title,
                body,
                confirmLabel: 'Relancer',
                cancelLabel: 'Non',
                confirm: () => resolve(true),
                cancel: () => resolve(false),
            }, { onClose: () => resolve(false) });
        });
    }

    /**
     * Calls an aslan_omni_* method of this payment method on the Odoo server.
     * Returns its {httpStatus, body} or {error}. A failed RPC (browser↔Odoo) is
     * reported as 'network', which the payment loop retries on the same ref.
     */
    async _callOmni(method, args, kwargs = {}) {
        try {
            return await this.env.services.orm.silent.call(
                'pos.payment.method', method, [[this.payment_method_id.id], ...args], kwargs,
            );
        } catch (_err) {
            return { error: 'network' };
        }
    }
}

// Register with the payment-provider registry. The key 'aslan_omni' must match
// the payment_provider value declared in models/pos_payment_method.py.
registry.category('pos_payment_providers').add('aslan_omni', PaymentAslanOmni);
