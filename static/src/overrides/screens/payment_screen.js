/** @odoo-module **/

import { PaymentScreen } from '@point_of_sale/app/screens/payment_screen/payment_screen';
import { patch } from '@web/core/utils/patch';

patch(PaymentScreen.prototype, {
    /**
     * Hide cash (Cashmatic) payment methods whose paired terminal reported
     * `hasRecycler: false` on session start. The flag is set by
     * overrides/app/pos_store.js and never leaves the client — the server
     * still validates on /cloud/pay, so this is UX, not security.
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
        const filtered = base.filter(m => !m?.aslanCashHiddenByCapability);
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
//   1. super returns the v17 shape [{id:1}, {id:2, aslanCashHiddenByCapability:true}]
//      → filtered list contains only {id:1}.
//   2. super returns undefined (version drift) → returns [] and logs a warning.
//   3. super returns [{id:1, aslanCashHiddenByCapability:true}] (every method
//      hidden) → fails open, returns the raw super array unchanged.
// The Odoo POS QUnit harness isn't wired into this addon yet; leaving this
// as an explicit TODO rather than adding half a test runner.
