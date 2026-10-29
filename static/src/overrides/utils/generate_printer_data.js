import { GeneratePrinterData } from "@point_of_sale/app/utils/printer/generate_printer_data";
import { patch } from "@web/core/utils/patch";

patch(GeneratePrinterData.prototype, {
    generatePaymentData() {
        const payments = super.generatePaymentData(...arguments);
        // this.order.payment_ids is in the same order as the `payments` array above.
        this.order.payment_ids.forEach((line, i) => {
            if (line.payment_method_id?.payment_provider === 'aslan_omni' && line.uiState?.aslanOmniResult) {
                payments[i].aslan_omni_result = line.uiState.aslanOmniResult;
            }
        });
        return payments;
    },
});
