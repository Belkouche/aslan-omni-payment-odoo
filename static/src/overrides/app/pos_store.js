/** @odoo-module **/

import { PosStore } from '@point_of_sale/app/store/pos_store';
import { patch } from '@web/core/utils/patch';

// Per-probe timeout. Short enough that N recyclers x PROBE_TIMEOUT_MS
// never gates the cashier opening the till, long enough that a real
// LAN round-trip to a terminal has a fair chance of landing.
const PROBE_TIMEOUT_MS = 5000;

patch(PosStore.prototype, {
    /**
     * After the POS session loads, probe each aslan_cash payment method for
     * recycler availability. A method with no online recycler (or on a VPS
     * terminal that can't broker a recycler) gets `aslanCashHiddenByCapability`
     * set, which the payment screen checks before rendering the button.
     *
     * This is a one-shot probe at session start — the cashier reopens the
     * session if the recycler comes online later. Probes run in parallel
     * (Promise.allSettled), each with a 5 s timeout, so one slow / offline
     * terminal can never block session open past that budget.
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
        if (methods.length === 0) {
            return;
        }
        // Default optimistic: method stays visible unless a probe positively
        // reports hasRecycler === false. Timeouts / RPC errors therefore keep
        // the method visible, matching the fail-open stance in payment_screen.
        for (const method of methods) {
            method.aslanCashHiddenByCapability = false;
        }
        await Promise.allSettled(
            methods.map(method => this._probeOne(method, PROBE_TIMEOUT_MS)),
        );
    },

    async _probeOne(method, timeoutMs) {
        let timer;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`aslan_cash capability probe timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
        });
        try {
            const call = this.env.services.orm.silent.call(
                'pos.payment.method', 'aslan_cash_device_capabilities', [[method.id]],
            );
            const res = await Promise.race([call, timeout]);
            if (res && !res.error && res.httpStatus === 200) {
                method.aslanCashHiddenByCapability = !res.body?.hasRecycler;
            }
        } catch (err) {
            // Timeout or RPC error: keep the method visible (already set above).
            // Log once so operators can see why a cash method stayed shown
            // despite the backing terminal being unreachable.
            console.warn(
                `[aslan_omni_payment] capability probe failed for method ${method.id}:`,
                err?.message || err,
            );
        } finally {
            clearTimeout(timer);
        }
    },

});
