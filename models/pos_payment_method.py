import logging
import re

import requests

from odoo import api, fields, models
from odoo.exceptions import AccessDenied, ValidationError

_logger = logging.getLogger(__name__)

# The API answers pay/reverse with wait=False right after relaying the command,
# so every call made from here is short.
ASLAN_OMNI_TIMEOUT = 15


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
    # Restricted to POS managers and never sent to the POS client: payment calls go
    # through the aslan_omni_* methods below, which use it server-side.
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

    aslan_omni_print_merchant_receipt = fields.Boolean(
        string='Print merchant card receipt',
        default=True,
        help='Print the merchant copy of the card slip, cut from the customer receipt.',
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
        params += ['aslan_omni_device_id', 'aslan_omni_print_merchant_receipt']
        return params

    def aslan_omni_send_payment(self, ref, amount_cents, cashier_id=None, till_id=None, description=None):
        """Relay a payment to the paired terminal. Called from the POS client."""
        return self._aslan_omni_request('POST', '/cloud/pay', {
            'ref': ref,
            'amountCents': amount_cents,
            'cashierId': cashier_id or None,
            'tillId': till_id or None,
            'description': description or None,
            'wait': False,
        })

    def aslan_omni_send_reversal(self, ref, original_ref, stan):
        """Relay a reversal of an approved payment. Called from the POS client."""
        return self._aslan_omni_request('POST', '/cloud/reverse', {
            'ref': ref,
            'originalRef': original_ref,
            'stan': stan,
            'wait': False,
        })

    def aslan_omni_command_status(self, command_id):
        """Status of a payment or reversal command. Called from the POS client."""
        # The id goes into the URL path; refuse anything that could change the path.
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(command_id or '')):
            return {'error': 'invalid_command'}
        return self._aslan_omni_request('GET', f'/cloud/pay/{command_id}/status')

    def _aslan_omni_request(self, method, path, payload=None):
        """Call the Omni API with the merchant key, which never leaves the server.

        Returns {'httpStatus': int, 'body': dict}, or {'error': 'not_configured' | 'network'}.
        """
        self.ensure_one()
        if not self.env.su and not self.env.user.has_group('point_of_sale.group_pos_user'):
            raise AccessDenied()
        self.check_access('read')  # record rules (e.g. multi-company) before going sudo
        method_sudo = self.sudo()
        if method_sudo.payment_provider != 'aslan_omni' or not method_sudo.aslan_omni_api_key \
                or not method_sudo.aslan_omni_device_id:
            return {'error': 'not_configured'}
        url = (method_sudo.aslan_omni_api_url or 'https://api.aslanpay.ma').rstrip('/') + path
        if payload is not None:
            payload = {k: v for k, v in payload.items() if v is not None}
        try:
            resp = requests.request(
                method, url, json=payload, timeout=ASLAN_OMNI_TIMEOUT,
                headers={
                    'Authorization': f'Bearer {method_sudo.aslan_omni_api_key}',
                    'X-Device-Id': method_sudo.aslan_omni_device_id,
                },
            )
        except requests.exceptions.RequestException as e:
            _logger.warning('Aslan Omni %s %s failed: %s', method, path, e)
            return {'error': 'network'}
        try:
            body = resp.json()
        except ValueError:
            body = {}
        return {'httpStatus': resp.status_code, 'body': body if isinstance(body, dict) else {}}

    # Non-stored dummy field — exists only as a mount point for the Owl pairing widget.
    aslan_omni_pair_widget = fields.Char(
        compute='_compute_pair_widget',
        store=False,
    )

    def _compute_pair_widget(self):
        for record in self:
            record.aslan_omni_pair_widget = ''
