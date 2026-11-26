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
     * `this.pos.aslanCashHiddenMap` (a reactive Map keyed by method id, set
     * by overrides/app/pos_store.js) and never leaves the client — the server
     * still validates on /cloud/pay, so this is UX, not security. Reading the
     * map inside this getter subscribes the PaymentScreen's render to it, so
     * a later probe result flips the UI without a reopen.
     *
     * Defensive: the base `payment_methods_from_config` is a getter on
     * recent Odoo builds but has shifted shape across 15 / 17 / 20
     * (array vs. object vs. a method on some backports). If the super
     * value isn't an array we fall back to [] and warn. If filtering
     * would wipe out an otherwise non-empty list we fail open and
     * return the raw super value — a blank payment screen locks the
     * till, which is operationally worse than showing an unexpected
     * method that the server still validates.
     */
    get payment_methods_from_config() {
        const raw = super.payment_methods_from_config;
        let base;
        if (Array.isArray(raw)) {
            base = raw;
        } else {
            // odoo.info?.server_version is set on live POS; fall back to
            // "unknown" when the global isn't exposed (e.g. in tests).
            const ver = (typeof odoo !== 'undefined' && odoo.info?.server_version) || 'unknown';
            console.warn(
                '[aslan_omni_payment] payment_methods_from_config super returned non-array ' +
                `(type=${raw === null ? 'null' : typeof raw}, odoo=${ver}); falling back to [].`,
            );
            base = [];
        }
        // aslanCashHiddenMap is a plain object keyed by method id (not a Map):
        // OWL 3 as shipped with Odoo 20 does not export `reactive`, and
        // Map.get() tracking inside the store's proxy is unreliable. The POS
        // store is itself a proxied instance, so reading an object property
        // here subscribes this render to it.
        const hiddenMap = this.pos?.aslanCashHiddenMap || {};
        const filtered = base.filter(m => !hiddenMap[m?.id]);
        if (filtered.length === 0 && base.length > 0) {
            console.error(
                '[aslan_omni_payment] capability filter emptied the payment methods list ' +
                '(recyclerId=null); failing open to the raw super value to keep the POS usable.',
            );
            return base;
        }
        return filtered;
    },
});

// QUnit smoke test note:
//
// Tests would live under `static/tests/payment_screen_patch_tests.js` and
// cover three cases against the patched getter:
//   1. super returns the v17 shape [{id:1}, {id:2}] and the pos store's
//      aslanCashHiddenMap has {2: true} → filtered list contains only {id:1}.
//   2. super returns undefined (version drift) → returns [] and logs a warning.
//   3. super returns [{id:1}] and the map has {1: true} (every method hidden)
//      → fails open, returns the raw super array unchanged.
// The Odoo POS QUnit harness isn't wired into this addon yet; leaving this
// as an explicit TODO rather than adding half a test runner.
