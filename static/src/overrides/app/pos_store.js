/** @odoo-module **/

// PosStore moved from @point_of_sale/app/store/pos_store (Odoo 17/18) to
// @point_of_sale/app/services/pos_store (Odoo 20+). This addon targets
// Odoo 20 per __manifest__, so the services/ path is the correct one.
// Verified against Odoo 20.0 source at
// addons/point_of_sale/static/src/app/services/pos_store.js (the store/
// subfolder returns 404 on GitHub for the 20.0 branch).
import { PosStore } from '@point_of_sale/app/services/pos_store';
import { patch } from '@web/core/utils/patch';

// Per-probe timeout. Short enough that N recyclers x PROBE_TIMEOUT_MS
// never gates the cashier opening the till, long enough that a real
// LAN round-trip to a terminal has a fair chance of landing.
const PROBE_TIMEOUT_MS = 5000;

patch(PosStore.prototype, {
    /**
     * After the POS session loads, probe each aslan_cash payment method for
     * recycler availability. A method with no online recycler (or on a VPS
     * terminal that can't broker a recycler) is marked hidden in
     * `aslanCashHiddenMap` (a plain object keyed by method id), which the
     * payment screen consults before rendering the button.
     *
     * We use a plain object rather than a Map or a `reactive(...)`-wrapped
     * container because:
     *   - Upstream OWL 3 as shipped with Odoo 20 does NOT export `reactive`
     *     from `@odoo/owl` — the earlier `import { reactive } from '@odoo/owl'`
     *     threw at module load. Only `proxy` is available, and Map/Set
     *     tracking inside proxies is historically version-dependent.
     *   - The PosStore itself is wrapped in `proxy(this)` by Odoo 20, so any
     *     plain data assigned to `this.*` is already observable: the
     *     PaymentScreen render that reads `this.pos.aslanCashHiddenMap[id]`
     *     subscribes to the underlying proxy and re-renders when we re-assign
     *     the map (we spread to a new object on each set so the top-level
     *     reference changes — the safest publish signal).
     *
     * This is a one-shot probe at session start — the cashier reopens the
     * session if the recycler comes online later. Probes run in parallel
     * (Promise.allSettled), each with a 5 s timeout, so one slow / offline
     * terminal can never block session open past that budget.
     */
    async afterProcessServerData(loadedData) {
        const res = await super.afterProcessServerData(...arguments);
        // Create the hidden-flags map lazily on first session load.
        if (!this.aslanCashHiddenMap) {
            this.aslanCashHiddenMap = {};
        }
        try {
            await this._probeAslanCashCapabilities();
        } catch (_e) {
            // Non-fatal: default to showing the method and let the server
            // reject the payment with a clean error if something is off.
        }
        // Shape guard (issue #10 Option A): if anything above left the map in
        // a non-object shape (e.g. OWL reactivity semantics shifted again and
        // our top-level reassignment produced a Proxy that no longer reports
        // `typeof === 'object'`, or a defensive refactor accidentally set it
        // to a Map again), log loudly and reset so PaymentScreen's `[id]`
        // lookup never throws. The previous try/catch would silently swallow
        // this class of regression — we trade silence for a console.error.
        const map = this.aslanCashHiddenMap;
        if (map === null || typeof map !== 'object' || Array.isArray(map)
                || typeof map.get === 'function') {
            console.error(
                '[aslan_omni_payment] aslanCashHiddenMap in unexpected shape ' +
                `(${map === null ? 'null' : typeof map}` +
                `${Array.isArray(map) ? '/array' : ''}` +
                `${typeof map?.get === 'function' ? '/Map-like' : ''}); ` +
                'resetting to {} and failing open.',
            );
            this.aslanCashHiddenMap = {};
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
        const seeded = { ...this.aslanCashHiddenMap };
        for (const method of methods) {
            seeded[method.id] = false;
        }
        this.aslanCashHiddenMap = seeded;
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
                // Reassign the whole object so the top-level reference changes,
                // which is the reliable way to publish an update through the
                // store's proxy (keyed writes on the same object are observed
                // on OWL 3 but Map.set() is not).
                this.aslanCashHiddenMap = {
                    ...this.aslanCashHiddenMap,
                    [method.id]: !res.body?.hasRecycler,
                };
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
