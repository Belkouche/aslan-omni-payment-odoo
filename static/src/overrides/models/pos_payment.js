import { PosPayment } from "@point_of_sale/app/models/pos_payment";
import { patch } from "@web/core/utils/patch";

patch(PosPayment.prototype, {
    setup() {
        super.setup(...arguments);
        // setup() runs again when the record is updated: keep values already set.
        this.uiState = {
            aslanOmniRef: null,
            aslanOmniResult: null,
            aslanOmniMerchantPrinted: false,
            ...(this.uiState ?? {}),
        };
    },
});
