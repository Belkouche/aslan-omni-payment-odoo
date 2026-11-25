/** @odoo-module **/

import { PaymentScreen } from '@point_of_sale/app/screens/payment_screen/payment_screen';
import { patch } from '@web/core/utils/patch';

patch(PaymentScreen.prototype, {
    /**
     * Hide cash (Cashmatic) payment methods whose paired terminal reported
     * `hasRecycler: false` on session start. The flag is set by
     * overrides/app/pos_store.js and never leaves the client — the server
     * still validates on /cloud/pay, so this is UX, not security.
     */
    get payment_methods_from_config() {
        const base = super.payment_methods_from_config ?? [];
        return base.filter(m => !m.aslanCashHiddenByCapability);
    },
});
