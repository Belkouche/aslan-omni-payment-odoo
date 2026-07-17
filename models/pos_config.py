from odoo import api, fields, models
from odoo.exceptions import ValidationError


class PosConfig(models.Model):
    _inherit = 'pos.config'

    aslan_omni_device_id = fields.Char(
        string='Aslan Omni Device ID',
        readonly=True,
        help='Device ID returned after pairing with the Aslan Omni terminal.',
    )
    # Restricted to POS managers — cashiers must not be able to read the bearer token.
    aslan_omni_api_key = fields.Char(
        string='Aslan Omni API Key',
        readonly=True,
        groups='point_of_sale.group_pos_manager,base.group_system',
        help='Merchant API key returned after pairing. Sent in Authorization header.',
    )
    aslan_omni_api_url = fields.Char(
        string='Aslan Omni API URL',
        default='https://api.aslanpay.ma',
        help='Base URL of the Aslan Omni API (cloud relay endpoint).',
    )

    @api.constrains('aslan_omni_api_url')
    def _check_aslan_omni_api_url(self):
        for record in self:
            url = record.aslan_omni_api_url or ''
            if url and not url.startswith('https://'):
                raise ValidationError(
                    'Aslan Omni API URL must use HTTPS to protect credentials in transit.'
                )
    aslan_omni_pair_widget = fields.Char(
        compute='_compute_pair_widget',
        store=False,
    )

    def _compute_pair_widget(self):
        for r in self:
            r.aslan_omni_pair_widget = ''
