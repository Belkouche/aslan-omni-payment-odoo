/** @odoo-module **/

import { PaymentInterface } from '@point_of_sale/app/utils/payment/payment_interface';
import { registry } from '@web/core/registry';
import { AlertDialog, ConfirmationDialog } from '@web/core/confirmation_dialog/confirmation_dialog';
import { Component } from '@odoo/owl';

// Cash commands have a 300 s TTL server-side (5 min) — cashiers take longer than
// card auth. Poll a little past that so the last poll sees the server's timeout.
const CASH_PAYMENT_TIMEOUT_MS = 310000;
// Short interval: the cashier is watching the dialog, and change dispensing is
// snappy on the Cashmatic.
const POLL_INTERVAL_MS = 1500;
const MAX_RECOVERY_ATTEMPTS = 2;

const RETRYABLE_ERRORS = ['network', 'api_unreachable'];

const MSG_NOT_CONFIGURED = 'Terminal Cashmatic non configuré. Associez un terminal dans les paramètres.';
const MSG_CHECK          = 'Vérifiez le recycleur avant de relancer.';
const MSG_ODOO_LOST      = `Connexion au serveur Odoo perdue. ${MSG_CHECK}`;
const MSG_API_LOST       = `Le serveur Odoo n'arrive pas à joindre Aslan. ${MSG_CHECK}`;
const MSG_UNCERTAIN      = `Résultat incertain. ${MSG_CHECK}`;
const MSG_NO_REVERSAL    = "L'annulation d'un paiement en espèces déjà remis n'est pas possible — effectuez un remboursement manuel.";

// Preset tip amounts (MAD) offered to the cashier when the picker is enabled.
// Mirrors the three buttons the brief calls out plus a free-form entry.
const TIP_PRESETS_MAD = [0, 5, 10, 20];

/**
 * Modal that collects a tip amount from the cashier. The customer has already
 * agreed to leave a tip, verbally or on the ticket; the cashier picks it on the
 * POS and it is added to the cash amount requested from the recycler.
 *
 * Template is registered as 'aslan_omni_payment.CashTipPicker' in
 * aslan_cash_tip_picker.xml (QWeb, loaded with the POS asset bundle).
 */
class CashTipPicker extends Component {
    static template = 'aslan_omni_payment.CashTipPicker';
    static props = {
        close: { type: Function, optional: true },
        baseAmount: Number,
        formatCurrency: Function,
        onConfirm: Function,
    };

    setup() {
        // Reactive state via OWL 3's `proxy` — OWL has moved away from useState.
        // See the card pairing widget (aslan_omni_pairing_widget.js) for the same
        // pattern. We don't need to import proxy here since this component only
        // mutates state inside event handlers that trigger renders directly.
        this.state = { selectedCents: 0, customText: '' };
        this.presets = TIP_PRESETS_MAD;
    }

    pickPreset(mad) {
        this.state.selectedCents = Math.round(mad * 100);
        this.state.customText = '';
        this.render();
    }

    onCustomInput(ev) {
        const raw = String(ev.target.value || '').replace(',', '.').trim();
        this.state.customText = raw;
        const n = Number.parseFloat(raw);
        if (Number.isFinite(n) && n >= 0) {
            this.state.selectedCents = Math.round(n * 100);
            this.render();
        }
    }

    get totalWithTipCents() {
        return Math.round(this.props.baseAmount * 100) + this.state.selectedCents;
    }

    isPresetActive(mad) {
        return this.state.selectedCents === Math.round(mad * 100);
    }

    confirm() {
        this.props.onConfirm(this.state.selectedCents);
        this.props.close?.();
    }

    cancel() {
        this.props.onConfirm(null);
        this.props.close?.();
    }
}

export class PaymentAslanCash extends PaymentInterface {

    setup() {
        super.setup(...arguments);
        // Keyed by line.uuid: the in-flight session per payment line. Cancel
        // marks it cancelled and wakes the poll loop.
        this._sessions = new Map();
    }

    /**
     * Stable idempotency key for a cash payment line. Same design as the card
     * path: the server dedups commands on `ref`, so a retry with the same ref
     * re-attaches to the running or completed command instead of starting a
     * second cash collection. `ODOC-` prefix to make cash refs distinguishable
     * from card ones in logs. 'ODOC-' + 32 hex chars = 37 chars (< 40 cap).
     */
    _payRef(line) {
        return `ODOC-${line.uuid.replace(/-/g, '')}`;
    }

    /**
     * Called when the cashier clicks "Charge" on the cash method.
     * 1. If the method has tips enabled, ask the cashier for a tip amount.
     * 2. Relay the payment to the API; the Sunmi broker drives the Cashmatic.
     * 3. Poll /status, show live state, handle partial / cancel / approved.
     */
    async sendPaymentRequest(line) {
        await super.sendPaymentRequest(...arguments);

        if (!line.payment_method_id.aslan_omni_device_id) {
            this._showError(MSG_NOT_CONFIGURED);
            return false;
        }

        // Tip picker (cashier-driven; see cashmatic-tips.md — the Cashmatic
        // firmware we have doesn't support a device-side tip picker).
        let tipsCents = 0;
        if (line.payment_method_id.aslan_cash_tips_enabled) {
            const picked = await this._askForTip(line.amount);
            if (picked === null) {
                // Cashier cancelled the tip dialog: cancel the payment attempt.
                line.setPaymentStatus('retry');
                return false;
            }
            tipsCents = picked;
        }
        line.uiState.aslanCashTipsAmountCents = tipsCents;

        const ref = this._payRef(line);
        line.uiState.aslanCashRef = ref;
        line.setPaymentStatus('waitingCard');  // Odoo reuses this label — no "waitingCash" exists
        return this._sendPayment(line, tipsCents);
    }

    async _sendPayment(line, tipsCents) {
        const session = { cancelled: false, wake: null, order: line.pos_order_id, attempt: 1 };
        this._sessions.set(line.uuid, session);

        const cashier = this.pos.accessRight.cashier;
        const args = [
            line.uiState.aslanCashRef,
            Math.round(line.amount * 100),
            tipsCents,
            String(cashier?.id || ''),
            String(this.pos.config.id),
            line.pos_order_id.name || line.pos_order_id.pos_reference || false,
        ];

        for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
            const res = await this._callOmni('aslan_cash_send_payment', args);
            if (session.cancelled) {
                // Cash command may still be running on the recycler. Keep a
                // detached watcher so a late approved/partial is surfaced.
                if (res.body?.commandId) {
                    line.uiState.aslanCashCommandId = res.body.commandId;
                    this._watchAfterCancel(res.body.commandId, line, session, Date.now() + CASH_PAYMENT_TIMEOUT_MS);
                }
                return false;
            }
            if (RETRYABLE_ERRORS.includes(res.error) && attempt < MAX_RECOVERY_ATTEMPTS) {
                await this._sleep(POLL_INTERVAL_MS, session);
                if (session.cancelled) return false;
                continue;
            }
            return this._handleCommandResponse(res, line, session);
        }
        return false;
    }

    /**
     * Cash cancel IS best-effort server-side: POST /cloud/pay/:commandId/cancel
     * pushes a CashCancelCommand to the broker. The recycler may already have
     * accepted customer cash — the result still arrives on /status with
     * insertedCents populated, and _handleResult surfaces that so the cashier
     * refunds the customer from the till.
     */
    async sendPaymentCancel(line) {
        const session = this._sessions.get(line.uuid);
        const commandId = line.uiState.aslanCashCommandId;

        if (session) {
            session.cancelled = true;
            session.wake?.();
        }

        // Fire the server-side cancel if we have a commandId. We don't wait on
        // the response — the running poll loop (or detached watcher) will see
        // the broker's cancelled result.
        if (commandId) {
            this._callOmni('aslan_cash_cancel', [commandId], { attempt: session?.attempt }).catch(() => {});
        }

        super.sendPaymentCancel(...arguments);
        line.setPaymentStatus('retry');
        this._notify(
            "Annulation demandée. Si le client avait déjà inséré de l'argent, le montant inséré sera affiché à la fin — rendez-le au client.",
            'warning', true,
        );
        return true;
    }

    /**
     * Cash has no reversal: once the money physically moved, only a cash refund
     * (handled outside the terminal) can undo it.
     */
    async sendReversal(/* line */) {
        this._showError(MSG_NO_REVERSAL);
        return false;
    }

    async _handleCommandResponse(res, line, session) {
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

        // 503 — no broker or broker offline.
        if (httpStatus === 503) {
            const code = body.error || '';
            this._showError(code === 'broker_offline'
                ? 'Le terminal relais du recycleur est hors ligne. Vérifiez qu\'il est allumé et connecté.'
                : 'Service recycleur momentanément indisponible. Réessayez dans un instant.');
            line.setPaymentStatus('retry');
            return false;
        }

        // 400 — cash not supported on this (VPS) terminal: should have been
        // hidden by the capability gate; if we still see it, tell the cashier.
        if (httpStatus === 400 && body.error === 'cash_not_supported_for_vps') {
            this._showError('Ce terminal ne prend pas en charge les paiements en espèces.');
            line.setPaymentStatus('retry');
            return false;
        }

        // 409s: either no/busy recycler, or an existing command on this ref.
        if (httpStatus === 409) {
            const code = body.error;
            if (code === 'no_recycler_paired') {
                this._showError('Aucun recycleur n\'est associé à ce marchand.');
                line.setPaymentStatus('retry');
                return false;
            }
            if (code === 'recycler_unavailable') {
                this._showError('Le recycleur est hors ligne — vérifiez sa connexion et son état.');
                line.setPaymentStatus('retry');
                return false;
            }
            if (code === 'recycler_busy') {
                this._showError('Le recycleur est occupé par une autre transaction. Attendez qu\'elle se termine.');
                line.setPaymentStatus('retry');
                return false;
            }
            if (code === 'cash_in_progress' && body.commandId) {
                // Our ref already has a running command; attach to it.
                line.uiState.aslanCashCommandId = body.commandId;
                return this._pollForResult(body.commandId, line, session);
            }
            if (code === 'cash_already_completed') {
                this._showError(`Ce paiement a déjà été enregistré (statut: ${body.resultStatus || 'inconnu'}).`);
                line.setPaymentStatus('retry');
                return false;
            }
            if (code === 'cash_delivery_uncertain') {
                this._showError(MSG_UNCERTAIN);
                line.setPaymentStatus('retry');
                return false;
            }
            if (code === 'method_mismatch') {
                this._showError('Conflit : cette référence est déjà utilisée pour un paiement par carte.');
                line.setPaymentStatus('retry');
                return false;
            }
            this._showError(`Erreur serveur: ${body.error || httpStatus}`);
            line.setPaymentStatus('retry');
            return false;
        }

        // 202 — command relayed; store its id and poll.
        if (httpStatus === 202 && body.commandId) {
            line.uiState.aslanCashCommandId = body.commandId;
            return this._pollForResult(body.commandId, line, session);
        }

        if (httpStatus < 200 || httpStatus >= 300) {
            this._showError(`Erreur serveur: ${body.error || httpStatus}`);
            line.setPaymentStatus('retry');
            return false;
        }
        // Shouldn't happen (cash never returns a final result synchronously),
        // but handle it defensively for forward-compat.
        return this._handleResult(body, line, session);
    }

    async _pollForResult(commandId, line, session) {
        const startedAt = Date.now();
        const deadline = startedAt + CASH_PAYMENT_TIMEOUT_MS;
        let lastStageNotified = null;
        const requested = Math.round(line.amount * 100) + (line.uiState.aslanCashTipsAmountCents || 0);
        const requestedFmt = this.pos.formatCurrency(requested / 100);
        this._notify(`En attente de l'insertion… ${requestedFmt} requis.`, 'info');

        while (Date.now() < deadline) {
            await this._sleep(POLL_INTERVAL_MS, session);
            if (session.cancelled) {
                this._watchAfterCancel(commandId, line, session, deadline);
                return false;
            }
            const res = await this._callOmni('aslan_cash_command_status', [commandId]);
            if (session.cancelled) {
                this._watchAfterCancel(commandId, line, session, deadline);
                return false;
            }
            if (res.error || res.httpStatus !== 200) continue;
            const data = res.body;

            if (data.status === 'completed') {
                return this._handleResult({ ...data, status: data.resultStatus }, line, session);
            }
            if (data.status === 'timeout') {
                return this._handleResult({ ...data, status: 'timeout' }, line, session);
            }
            // status === 'pending' — surface stage transitions as non-blocking notifications.
            if (data.stage && data.stage !== lastStageNotified) {
                lastStageNotified = data.stage;
                if (data.stage === 'received') {
                    this._notify('Le recycleur a reçu la commande.', 'info');
                } else if (data.stage === 'started') {
                    this._notify("Insertion en cours sur le recycleur.", 'info');
                }
            }
        }

        // Deadline reached — one last poll before giving up.
        const last = await this._callOmni('aslan_cash_command_status', [commandId]);
        if (session.cancelled) return false;
        if (!last.error && last.httpStatus === 200 && last.body.status === 'completed') {
            return this._handleResult({ ...last.body, status: last.body.resultStatus }, line, session);
        }
        this._showError(MSG_UNCERTAIN);
        line.setPaymentStatus('retry');
        return false;
    }

    async _watchAfterCancel(commandId, line, session, deadline) {
        // Keep following a cancelled command without touching the line. If the
        // recycler reports anything other than a clean cancel (cash inserted),
        // surface it to the cashier so they can refund the customer.
        while (Date.now() < deadline + POLL_INTERVAL_MS) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            if (this._sessions.get(line.uuid) !== session) return;
            const res = await this._callOmni('aslan_cash_command_status', [commandId]);
            if (this._sessions.get(line.uuid) !== session) return;
            if (res.error || res.httpStatus !== 200) continue;
            const data = res.body;
            if (data.status !== 'completed' && data.status !== 'timeout') continue;

            const inserted = Number.isInteger(data.insertedCents) ? data.insertedCents : 0;
            const resultStatus = data.resultStatus || data.status;
            // If the customer inserted money that the recycler never dispensed back
            // (cancelled/failed with insertedCents > 0 OR a partial), warn the cashier.
            if (resultStatus === 'approved' || resultStatus === 'partial') {
                this._notify(
                    'Le recycleur a finalisé le paiement malgré l\'annulation. Vérifiez la commande — relancez la ligne pour l\'enregistrer.',
                    'warning', true,
                );
                return;
            }
            if (inserted > 0) {
                const fmt = this.pos.formatCurrency(inserted / 100);
                this._confirmBlocking(
                    'Argent inséré par le client',
                    `Le client a inséré ${fmt} mais la transaction est annulée. Rendez cette somme au client.`,
                    `J'ai rendu ${fmt}`,
                ).then(() => {
                    this._logCashierAcknowledgement(line, `Annulation : ${fmt} rendu au client.`);
                });
            }
            return;
        }
    }

    /**
     * Terminal result handler for cash. Approved / partial / cancelled / failed / timeout.
     */
    async _handleResult(data, line, session) {
        const resultStatus = data.status; // we mapped resultStatus into status above
        const requestedCents = Math.round(line.amount * 100);
        const tipsCents = Number.isInteger(data.tipsAmountCents) ? data.tipsAmountCents
                        : (line.uiState.aslanCashTipsAmountCents || 0);
        const insertedCents = Number.isInteger(data.insertedCents) ? data.insertedCents : null;
        const dispensedCents = Number.isInteger(data.dispensedCents) ? data.dispensedCents : null;
        const owesCents = Number.isInteger(data.cashierOwesCustomerCents)
                        ? data.cashierOwesCustomerCents
                        : (Number.isInteger(data.notDispensedCents) ? data.notDispensedCents : 0);

        // SAFETY: if the API reports an amount, cross-check with the line.
        if (Number.isInteger(data.amountCents) && data.amountCents !== requestedCents) {
            const fmt = c => this.pos.formatCurrency(c / 100);
            this._showError(
                `Montant débité ${fmt(data.amountCents)} ≠ montant de la ligne ${fmt(requestedCents)}. `
                + `Corrigez la ligne puis relancez.`,
            );
            line.setPaymentStatus('retry');
            return false;
        }

        if (resultStatus === 'approved' || resultStatus === 'partial') {
            // For a partial: the recycler accepted the money and gave the customer
            // the goods, but couldn't fully dispense change — the cashier must
            // hand over the remainder from the till. BLOCKING modal until confirmed.
            if (resultStatus === 'partial' && owesCents > 0) {
                const owedFmt = this.pos.formatCurrency(owesCents / 100);
                const ok = await this._confirmBlocking(
                    'Monnaie manquante',
                    `Le recycleur n'a pas pu rendre la monnaie complète. Donnez ${owedFmt} au client depuis la caisse.`,
                    `J'ai donné ${owedFmt}`,
                );
                if (!ok) {
                    // Cashier dismissed without confirming — don't finalise the line.
                    // This is a hard safety stop.
                    line.setPaymentStatus('retry');
                    return false;
                }
                this._logCashierAcknowledgement(line,
                    `Partial cash payment: ${owedFmt} remis au client depuis la caisse.`);
            }

            line.setPaymentStatus('done');
            line.uiState.aslanCashResult = {
                status: resultStatus,
                requestedCents,
                tipsAmountCents: tipsCents,
                insertedCents,
                dispensedCents,
                notDispensedCents: owesCents,
                cashmaticTransactionId: data.cashmaticTransactionId || null,
                recyclerId: data.recyclerId || null,
                // Pre-formatted strings for the receipt template.
                companyName: this.pos.company.name,
                requested: this.pos.formatCurrency(requestedCents / 100),
                tipsAmount: tipsCents ? this.pos.formatCurrency(tipsCents / 100) : null,
                inserted: insertedCents !== null ? this.pos.formatCurrency(insertedCents / 100) : null,
                dispensed: dispensedCents !== null ? this.pos.formatCurrency(dispensedCents / 100) : null,
                owed: owesCents ? this.pos.formatCurrency(owesCents / 100) : null,
                cashierInitials: this._cashierInitials(),
                orderName: line.pos_order_id.name || '',
                // Local date/time at approval; the API doesn't return a cash txTime.
                txDate: new Date().toISOString().slice(0, 10),
                txTime: new Date().toTimeString().slice(0, 5),
            };
            return true;
        }

        // Non-success paths — if money was inserted, the cashier owes the customer.
        if (resultStatus === 'cancelled' || resultStatus === 'failed') {
            if (insertedCents && insertedCents > 0) {
                const fmt = this.pos.formatCurrency(insertedCents / 100);
                const ok = await this._confirmBlocking(
                    resultStatus === 'cancelled' ? 'Paiement annulé — argent à rendre' : 'Paiement échoué — argent à rendre',
                    `Le client a inséré ${fmt} mais la transaction est annulée. Rendez cette somme au client.`,
                    `J'ai rendu ${fmt}`,
                );
                if (ok) {
                    this._logCashierAcknowledgement(line, `${resultStatus}: ${fmt} rendu au client.`);
                }
            } else if (resultStatus === 'cancelled') {
                this._showError('Paiement en espèces annulé.');
            } else {
                this._showError('Paiement en espèces échoué sur le recycleur.');
            }
            line.setPaymentStatus('retry');
            return false;
        }

        if (resultStatus === 'timeout') {
            this._showError(`Délai expiré sur le recycleur. ${MSG_CHECK}`);
            line.setPaymentStatus('retry');
            return false;
        }

        // Unknown — treat as uncertain.
        this._showError(`Statut inattendu du recycleur (${resultStatus}). ${MSG_CHECK}`);
        line.setPaymentStatus('retry');
        return false;
    }

    // --- Capabilities gating (POS start-up) ---------------------------------

    /**
     * Called by the POS pre-session hook (see static/src/overrides/app/pos_store.js)
     * to probe whether this method's paired terminal has an online recycler.
     * Flips a transient flag the UI checks before showing the method.
     * On any error we default to "show it" — the server will still reject with a
     * clear error if the recycler isn't actually available.
     */
    async probeCapability(method) {
        const res = await this._callOmni('aslan_cash_device_capabilities', []);
        if (res.error || res.httpStatus !== 200) {
            // Default optimistic; a clean error at charge time is better than a
            // silently missing payment method.
            method.aslanCashHiddenByCapability = false;
            return;
        }
        method.aslanCashHiddenByCapability = !res.body?.hasRecycler;
    }

    // --- UI helpers ---------------------------------------------------------

    /** Returns null if the cashier cancelled the dialog, or the tip in cents. */
    _askForTip(baseAmount) {
        return new Promise(resolve => {
            let resolved = false;
            this.dialog.add(CashTipPicker, {
                baseAmount,
                formatCurrency: (v) => this.pos.formatCurrency(v),
                onConfirm: (cents) => {
                    resolved = true;
                    resolve(cents);
                },
            }, {
                onClose: () => { if (!resolved) resolve(null); },
            });
        });
    }

    /**
     * Blocking confirmation dialog the cashier MUST acknowledge before the
     * payment line is finalised (or dismissed). No cancel button — this is a
     * hard safety stop to prevent short-changing or losing track of inserted cash.
     */
    _confirmBlocking(title, body, confirmLabel) {
        return new Promise(resolve => {
            this.dialog.add(ConfirmationDialog, {
                title,
                body,
                confirmLabel,
                // No cancel button exposed: Odoo's ConfirmationDialog still
                // closes on ESC, so handle onClose as "not confirmed".
                cancelLabel: null,
                confirm: () => resolve(true),
                cancel:  () => resolve(false),
            }, { onClose: () => resolve(false) });
        });
    }

    _cashierInitials() {
        const name = this.pos.accessRight.cashier?.name || this.pos.user?.name || '';
        return name.split(/\s+/).map(p => p[0] || '').join('').slice(0, 3).toUpperCase();
    }

    /** Log a note on the pos.order for shift reconciliation. Best-effort. */
    _logCashierAcknowledgement(line, msg) {
        const order = line.pos_order_id;
        try {
            // Odoo 20 stores cashier notes on the order via internal_note; append.
            if (order) {
                const prev = order.internal_note || '';
                const entry = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${this._cashierInitials()}: ${msg}`;
                order.internal_note = prev ? `${prev}\n${entry}` : entry;
            }
        } catch (_e) {
            // Non-fatal: the receipt still carries the same info.
        }
    }

    _showError(msg) {
        this.dialog.add(AlertDialog, { title: 'Paiement en espèces', body: msg });
    }

    _notify(msg, type = 'info', sticky = false) {
        this.env.services.notification.add(msg, { title: 'Recycleur Cashmatic', type, sticky });
    }

    _sleep(ms, session) {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            session.wake = () => { clearTimeout(timer); resolve(); };
        });
    }

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

// Register under the key 'aslan_cash' — must match _get_terminal_provider_selection
// on the Python side.
registry.category('pos_payment_providers').add('aslan_cash', PaymentAslanCash);
