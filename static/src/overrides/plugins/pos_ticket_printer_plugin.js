import { PosTicketPrinterPlugin } from "@point_of_sale/app/plugins/pos_ticket_printer_plugin";
import { patch } from "@web/core/utils/patch";

patch(PosTicketPrinterPlugin.prototype, {
    async printOrderReceipt({ order, basic = false } = {}) {
        const result = await super.printOrderReceipt(...arguments);
        if (!basic) {
            await this.printAslanOmniMerchantSlips(order);
        }
        return result;
    },

    /**
     * Merchant copy of each Aslan Omni card slip, printed as a separate job right
     * after the order receipt (which carries the customer copy) so the printer
     * cuts between them. Once per payment line: reprints don't repeat it.
     */
    async printAslanOmniMerchantSlips(order) {
        for (const line of order.payment_ids) {
            const result = line.uiState?.aslanOmniResult;
            if (
                !result ||
                line.uiState.aslanOmniMerchantPrinted ||
                !line.payment_method_id?.aslan_omni_print_merchant_receipt
            ) {
                continue;
            }
            line.uiState.aslanOmniMerchantPrinted = true;
            const iframe = await this.generateIframe("aslan_omni_payment.card_slip", {
                payment: { aslan_omni_result: result },
            });
            await this.printWithFallback({ iframe });
        }
    },
});
