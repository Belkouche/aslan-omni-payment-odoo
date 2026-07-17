from odoo import api, fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    aslan_omni_device_id = fields.Char(
        string='Aslan Omni Device ID',
        readonly=True,
        help='Device ID returned after pairing with the Aslan Omni terminal.',
    )
    aslan_omni_api_key = fields.Char(
        string='Aslan Omni API Key',
        readonly=True,
        help='Merchant API key returned after pairing. Sent in Authorization header.',
    )
    aslan_omni_api_url = fields.Char(
        string='Aslan Omni API URL',
        default='https://api.aslanpay.ma',
        help='Base URL of the Aslan Omni API (cloud relay endpoint).',
    )
    aslan_omni_pair_widget = fields.Char(
        compute='_compute_pair_widget',
        store=False,
    )

    def _compute_pair_widget(self):
        for r in self:
            r.aslan_omni_pair_widget = ''
