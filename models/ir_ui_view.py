from odoo import api, models


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    @api.model
    def _get_xml_ids_to_load(self):
        # Ship the card slip template to the POS client so it can render it.
        return super()._get_xml_ids_to_load() + ['aslan_omni_payment.card_slip']
