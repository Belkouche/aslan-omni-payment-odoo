from odoo import api, fields, models
from odoo.exceptions import ValidationError


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    def _get_terminal_provider_selection(self):
        return super()._get_terminal_provider_selection() + [('aslan_omni', 'Aslan Omni')]

    aslan_omni_device_id = fields.Char(
        string='Aslan Omni Device ID',
        readonly=True,
        copy=False,
        help='Device ID returned after pairing with the Aslan Omni terminal.',
    )
    # Restricted to POS managers — cashiers must not be able to read the bearer token.
    aslan_omni_api_key = fields.Char(
        string='Aslan Omni API Key',
        readonly=True,
        copy=False,
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

    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        params += ['aslan_omni_device_id', 'aslan_omni_api_key', 'aslan_omni_api_url']
        return params

    # Non-stored dummy field — exists only as a mount point for the Owl pairing widget.
    aslan_omni_pair_widget = fields.Char(
        compute='_compute_pair_widget',
        store=False,
    )

    def _compute_pair_widget(self):
        for record in self:
            record.aslan_omni_pair_widget = ''
