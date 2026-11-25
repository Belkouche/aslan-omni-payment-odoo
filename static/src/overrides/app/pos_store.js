/** @odoo-module **/

import { PosStore } from '@point_of_sale/app/store/pos_store';
import { patch } from '@web/core/utils/patch';

patch(PosStore.prototype, {
    /**
     * After the POS session loads, probe each aslan_cash payment method for
     * recycler availability. A method with no online recycler (or on a VPS
     * terminal that can't broker a recycler) gets `aslanCashHiddenByCapability`
     * set, which the payment screen checks before rendering the button.
     *
     * This is a one-shot probe at session start — the cashier reopens the
     * session if the recycler comes online later. Cheap: one HTTP call per
     * cash method on open.
     */
    async afterProcessServerData(loadedData) {
        const res = await super.afterProcessServerData(...arguments);
        try {
            await this._probeAslanCashCapabilities();
        } catch (_e) {
            // Non-fatal: default to showing the method and let the server
            // reject the payment with a clean error if something is off.
        }
        return res;
    },

    async _probeAslanCashCapabilities() {
        const methods = (this.models?.['pos.payment.method']?.getAll?.() || [])
            .filter(m => m.payment_provider === 'aslan_cash' && m.aslan_omni_device_id);
        for (const method of methods) {
            // Default optimistic; flipped to true only on a positive negative answer.
            method.aslanCashHiddenByCapability = false;
            try {
                const res = await this.env.services.orm.silent.call(
                    'pos.payment.method', 'aslan_cash_device_capabilities', [[method.id]],
                );
                if (!res.error && res.httpStatus === 200) {
                    method.aslanCashHiddenByCapability = !res.body?.hasRecycler;
                }
            } catch (_err) {
                // Keep the method visible on an RPC error.
            }
        }
    },

});
