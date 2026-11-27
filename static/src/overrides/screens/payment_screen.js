/** @odoo-module **/

import { PaymentScreen } from '@point_of_sale/app/screens/payment_screen/payment_screen';
import { patch } from '@web/core/utils/patch';

patch(PaymentScreen.prototype, {
    /**
     * Force-done hook for stuck aslan_cash lines (issue #8).
     *
     * When the cashier marks a stuck cash line as done manually (recycler
     * offline, broker unreachable, SSE drops mid-command), we fire a
     * server-side cancel so the broker stops pushing the command and the
     * Cashmatic releases its running session. Fire-and-forget — the cashier
     * is already past the line. Mirrors the pattern that core pos_cashmatic
     * uses for its own "cancelCurrentPayment" on force-done.
     *
     * Card (aslan_omni) does NOT need this: the card terminal owns its own
     * cancel/timeout, and aslan_omni_send_reversal takes a STAN that only
     * exists after an approval — not during a stuck "waiting" state. If the
     * card is force-done mid-command the terminal times out on its own.
     */
    async sendForceDone(line) {
        const method = line.payment_method_id;
        if (method?.payment_provider === 'aslan_cash') {
            const commandId = line.uiState?.aslanCashCommandId;
            if (commandId && this.env?.services?.orm?.silent) {
                Promise.resolve(
                    this.env.services.orm.silent.call(
                        'pos.payment.method', 'aslan_cash_cancel',
                        [[method.id], commandId],
                    ),
                ).catch(err => {
                    console.warn(
                        '[aslan_omni_payment] sendForceDone cash cancel failed:',
                        err?.message || err,
                    );
                });
            }
        }
        return super.sendForceDone(...arguments);
    },
    /**
     * Hide cash (Cashmatic) payment methods whose paired terminal reported
     * `hasRecycler: false` on session start. The hidden state lives on
     * `this.pos.aslanCashHiddenMap` (a plain object keyed by method id, set
     * by overrides/app/pos_store.js) and never leaves the client — the server
     * still validates on /cloud/pay, so this is UX, not security.
     *
     * Implementation note (v1.3.3): we patch `showPaymentMethod(pm)` rather
     * than `get payment_methods_from_config` because, from Odoo 20.1 on,
     * `payment_methods_from_config` is a PLAIN INSTANCE PROPERTY assigned in
     * `setup()` (payment_screen.js:40: `this.payment_methods_from_config =
     * this.configPaymentMethods || []`). Previous versions of this override
     * used a getter patch, which on 20.1 crashed with "Cannot set property
     * payment_methods_from_config of #<PaymentScreen> which has only a
     * getter" — the base setup's assignment hit our getter-without-setter
     * and blew up module loading for the whole addon.
     *
     * `showPaymentMethod` is called inside the base `displayedPaymentMethods`
     * getter (payment_screen.js:117-122), so returning false here still
     * subscribes PaymentScreen's render to our `aslanCashHiddenMap` changes
     * via OWL reactivity — a later probe result flips the UI without a reopen.
     *
     * Fail-open semantics preserved: if the hidden map is empty / missing
     * (probe hasn't run, store isn't ready), we always return the base
     * decision. We only return `false` when we have a positive
     * "this method is hidden" signal.
     */
    showPaymentMethod(paymentMethod) {
        const baseVisible = super.showPaymentMethod(...arguments);
        if (!baseVisible) return false;
        // Only aslan_cash methods are candidates for capability-based hiding.
        // Card (aslan_omni) and third-party methods are never touched here.
        if (paymentMethod?.payment_provider !== 'aslan_cash') return true;
        const hiddenMap = this.pos?.aslanCashHiddenMap;
        if (!hiddenMap || typeof hiddenMap !== 'object') return true;
        // Treat missing / falsy entries as "visible" (probe hasn't run yet,
        // or explicitly flagged hasRecycler=true). Only hide on an explicit
        // truthy flag.
        return hiddenMap[paymentMethod.id] ? false : true;
    },
});

// QUnit smoke test note:
//
// Tests would live under `static/tests/payment_screen_patch_tests.js` and
// cover four cases against the patched showPaymentMethod:
//   1. non-aslan_cash provider → always returns the base decision.
//   2. aslan_cash + empty/missing hiddenMap → returns true (fail open).
//   3. aslan_cash + hiddenMap[id] === true → returns false.
//   4. aslan_cash + hiddenMap[id] === false → returns true.
// The Odoo POS QUnit harness isn't wired into this addon yet; leaving this
// as an explicit TODO rather than adding half a test runner.
