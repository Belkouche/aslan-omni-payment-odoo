import { PosTicketPrinterPlugin } from "@point_of_sale/app/plugins/pos_ticket_printer_plugin";
import { patch } from "@web/core/utils/patch";

patch(PosTicketPrinterPlugin.prototype, {
    async printOrderReceipt({ order, basic = false } = {}) {
        if (basic) {
            return super.printOrderReceipt(...arguments);
        }
        if (!this.hasReceiptPrinters) {
            // Browser printing: the order receipt and a second print share one hidden
            // iframe and window.print() doesn't block, so a separate merchant job would
            // replace the receipt before the dialog renders. Print the merchant copy
            // in the same document, on its own page, instead.
            const lines = this._aslanOmniMerchantSlipLines(order);
            lines.forEach((line) => (line.uiState.aslanOmniMerchantInline = true));
            try {
                return await super.printOrderReceipt(...arguments);
            } finally {
                lines.forEach((line) => {
                    line.uiState.aslanOmniMerchantInline = false;
                    line.uiState.aslanOmniMerchantPrinted = true;
                });
            }
        }
        const result = await super.printOrderReceipt(...arguments);
        await this.printAslanOmniMerchantSlips(order);
        return result;
    },

    /** Payment lines whose merchant card slip is still to print. */
    _aslanOmniMerchantSlipLines(order) {
        return order.payment_ids.filter(
            (line) =>
                line.uiState?.aslanOmniResult &&
                !line.uiState.aslanOmniMerchantPrinted &&
                line.payment_method_id?.aslan_omni_print_merchant_receipt
        );
    },

    /**
     * Merchant copy of each Aslan Omni card slip, printed as a separate job right
     * after the order receipt (which carries the customer copy) so the printer
     * cuts between them. Once per payment line: reprints don't repeat it.
     */
    async printAslanOmniMerchantSlips(order) {
        for (const line of this._aslanOmniMerchantSlipLines(order)) {
            line.uiState.aslanOmniMerchantPrinted = true;
            const iframe = await this.generateIframe("aslan_omni_payment.card_slip", {
                payment: { aslan_omni_result: line.uiState.aslanOmniResult },
            });
            await this.printWithFallback({ iframe });
        }
    },
});
