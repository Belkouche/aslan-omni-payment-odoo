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
        return super()._get_terminal_provider_selection() + [
            ('aslan_omni', 'Aslan Omni (card)'),
        ]

    def _get_cash_machine_selection(self):
        # aslan_cash is a cash recycler, not a card terminal. Registering it
        # here lets core's _compute_payment_method_type set
        # payment_method_type = 'cash_machine' automatically, so this method
        # groups with Cashmatic/Cashdro/Glory in the admin UI and gets picked
        # up by session-close reconciliation, sale-details reports, and any
        # future cash-machine-specific core logic (see issue #7).
        return super()._get_cash_machine_selection() + [
            ('aslan_cash', 'Aslan Omni (Cashmatic cash recycler)'),
        ]

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

    # Cash-recycler (Cashmatic) settings. Only read when payment_provider == 'aslan_cash'.
    # The device_id/api_key/api_url fields above are reused: a cash payment method
    # points at the same paired Omni terminal (the Sunmi broker that drives the
    # physical Cashmatic over LAN). Pair once via the card method; the cash method
    # inherits those credentials automatically — see default_get and the write
    # override below, which are what make the help text's "pair once per terminal,
    # not per method" promise true.
    aslan_cash_tips_enabled = fields.Boolean(
        string='Enable tip picker on cash payments',
        default=False,
        help='Show a tip picker dialog before starting a cash payment. The tip is '
             'added to the amount requested from the customer by the recycler.',
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
    def default_get(self, fields_list):
        """Pre-fill a new aslan_cash method with credentials from its sibling
        aslan_omni card method, if one is already paired.

        The help text on the pairing widget promises "pair a terminal, not a
        specific payment method" — so when an operator adds a Cashmatic method
        after they've already paired the card method on the same POS, the form
        should open with device_id/api_key pre-filled, ready to save. Without
        this, the operator sees blank fields and (if they follow the on-screen
        instructions) tries to pair a second time, which creates a separate
        device claim that may never be consumed (orphan row in device claims).
        """
        values = super().default_get(fields_list)
        # Only act on a cash-recycler draft, and only if we're being asked for
        # the credential fields at all.
        wants_creds = any(
            f in fields_list
            for f in ('aslan_omni_device_id', 'aslan_omni_api_key', 'aslan_omni_api_url')
        )
        if not wants_creds:
            return values
        is_cash_draft = values.get('payment_provider') == 'aslan_cash' or (
            self.env.context.get('default_payment_provider') == 'aslan_cash'
        )
        if not is_cash_draft:
            return values
        # The form hasn't picked POS configs yet when opened from the "New"
        # button under a specific POS; context provides it via default_config_ids
        # (one-sided default from the related config view) OR active_id on the
        # pos.config form. Fall back to all siblings the user can see.
        config_ids = (
            self.env.context.get('default_config_ids')
            or self.env.context.get('active_ids')
            or []
        )
        domain = [('payment_provider', '=', 'aslan_omni'),
                  ('aslan_omni_device_id', '!=', False)]
        if config_ids:
            # Match any sibling card method that shares at least one POS config.
            domain.append(('config_ids', 'in', config_ids))
        sibling = self.env['pos.payment.method'].sudo().search(domain, limit=1)
        if not sibling:
            return values
        # sudo() so we can read aslan_omni_api_key (restricted to POS managers)
        # even when a non-manager has the group that creates payment methods;
        # the pairing widget itself runs under the same group boundary.
        if 'aslan_omni_device_id' in fields_list and not values.get('aslan_omni_device_id'):
            values['aslan_omni_device_id'] = sibling.aslan_omni_device_id
        if 'aslan_omni_api_key' in fields_list and not values.get('aslan_omni_api_key'):
            values['aslan_omni_api_key'] = sibling.aslan_omni_api_key
        if 'aslan_omni_api_url' in fields_list and not values.get('aslan_omni_api_url'):
            values['aslan_omni_api_url'] = sibling.aslan_omni_api_url
        return values

    def write(self, vals):
        """Propagate a newly-set device_id/api_key from an aslan_omni card
        method to its sibling aslan_cash recycler methods on the same POS(es).

        Covers the "card method already exists but blank → operator pairs it →
        the already-created cash method on the same POS stays blank" ordering.
        Without this the operator would pair the card method, then have to
        re-open every sibling cash method and wonder why its fields are still
        empty. Only overwrites blank siblings — never clobbers a cash method
        that was intentionally pointed at a different terminal.
        """
        result = super().write(vals)
        propagating = {k: vals[k] for k in ('aslan_omni_device_id', 'aslan_omni_api_key',
                                            'aslan_omni_api_url') if k in vals}
        if not propagating:
            return result
        # Only mirror writes coming from a card method — a write on a cash
        # method must not back-propagate to the card method (we treat the card
        # method as the source of truth).
        for record in self.filtered(lambda r: r.payment_provider == 'aslan_omni'):
            if not record.config_ids:
                continue
            siblings = self.sudo().search([
                ('payment_provider', '=', 'aslan_cash'),
                ('config_ids', 'in', record.config_ids.ids),
                ('id', '!=', record.id),
            ])
            for s in siblings:
                mirror = {}
                if 'aslan_omni_device_id' in propagating and not s.aslan_omni_device_id:
                    mirror['aslan_omni_device_id'] = propagating['aslan_omni_device_id']
                if 'aslan_omni_api_key' in propagating and not s.aslan_omni_api_key:
                    mirror['aslan_omni_api_key'] = propagating['aslan_omni_api_key']
                if 'aslan_omni_api_url' in propagating and (
                    not s.aslan_omni_api_url
                    or s.aslan_omni_api_url == 'https://api.aslanpay.ma'
                ):
                    # API URL has a non-blank default, so also mirror when the
                    # sibling is still on the default — otherwise a staging URL
                    # set on the card method would never reach the cash one.
                    mirror['aslan_omni_api_url'] = propagating['aslan_omni_api_url']
                if mirror:
                    # super().write to avoid recursing through this override on
                    # the aslan_cash side (it's a no-op there, but save the trip).
                    super(PosPaymentMethod, s).write(mirror)
        return result

    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        # aslan_omni_device_id is shared by both providers (same paired terminal).
        # Non-sensitive flags only: the API key stays server-side.
        params += [
            'aslan_omni_device_id',
            'aslan_omni_print_merchant_receipt',
        ]
        # Scope boundary: everything below is aslan_cash-only — the base
        # _load_pos_data_fields contract returns a flat field list per model,
        # so there is no per-record scoping hook. We mitigate by only adding
        # the aslan_cash_* fields when this POS config actually has an
        # aslan_cash payment method. A future aslan_cash-only flag added to
        # this block therefore inherits the scoping; one added to the block
        # above would leak to card/stay/etc., so DO NOT mix them.
        if config and any(
            m.payment_provider == 'aslan_cash' for m in config.payment_method_ids
        ):
            params += [
                'aslan_cash_tips_enabled',
            ]
        return params

    def aslan_omni_send_payment(self, ref, amount_cents, cashier_id=None, till_id=None, description=None,
                                force=False):
        """Relay a payment to the paired terminal. Called from the POS client.

        `force` (sent only when true) asks the API to re-arm a ref whose stored
        outcome is uncertain, after the cashier checked the terminal. An API that
        does not know the flag ignores it.
        """
        return self._aslan_omni_request('POST', '/cloud/pay', {
            'ref': ref,
            'amountCents': amount_cents,
            'cashierId': cashier_id or None,
            'tillId': till_id or None,
            'description': description or None,
            'wait': False,
            'force': True if force else None,
        })

    def aslan_omni_send_reversal(self, ref, original_ref, stan, force=False):
        """Relay a reversal of an approved payment. Called from the POS client."""
        return self._aslan_omni_request('POST', '/cloud/reverse', {
            'ref': ref,
            'originalRef': original_ref,
            'stan': stan,
            'wait': False,
            'force': True if force else None,
        })

    def aslan_omni_command_status(self, command_id):
        """Status of a payment or reversal command. Called from the POS client."""
        # The id goes into the URL path; refuse anything that could change the path.
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(command_id or '')):
            return {'error': 'invalid_command'}
        return self._aslan_omni_request('GET', f'/cloud/pay/{command_id}/status')

    # --- Cash (Cashmatic recycler) ------------------------------------------------
    # The server-side methods below drive the cash payment flow. They all go
    # through _aslan_omni_request, so the API key never leaves the server.

    def aslan_cash_send_payment(self, ref, amount_cents, tips_amount_cents=0,
                                cashier_id=None, till_id=None, description=None,
                                custom_display_message=None, allow_customer_cancel=True):
        """Start a cash payment on the Cashmatic recycler bound to this merchant.

        Everything is relayed through the paired Omni/Sunmi broker, which drives
        the physical Cashmatic over LAN. Odoo only hands the amount + tip.
        """
        return self._aslan_omni_request('POST', '/cloud/pay', {
            'ref': ref,
            'amountCents': amount_cents,
            'method': 'cash',
            'tipsAmountCents': tips_amount_cents or None,
            'cashierId': cashier_id or None,
            'tillId': till_id or None,
            'description': description or None,
            'customDisplayMessage': custom_display_message or None,
            # True is the API's default; sent explicitly so it's visible in traffic.
            'allowCustomerCancel': True if allow_customer_cancel else False,
            'wait': False,
        })

    def aslan_cash_cancel(self, command_id, attempt=None):
        """Cancel a pending cash command. Best-effort: the recycler may already
        have taken money before the cancel reaches the broker — the result still
        arrives via /status with insertedCents, which the POS surfaces to the
        cashier."""
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(command_id or '')):
            return {'error': 'invalid_command'}
        payload = {'attempt': attempt} if attempt is not None else None
        return self._aslan_omni_request('POST', f'/cloud/pay/{command_id}/cancel', payload)

    def aslan_cash_command_status(self, command_id):
        """Same shape as aslan_omni_command_status; cash branch returns additional
        fields (insertedCents, dispensedCents, notDispensedCents,
        cashierOwesCustomerCents, tipsAmountCents, cashmaticTransactionId)."""
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(command_id or '')):
            return {'error': 'invalid_command'}
        return self._aslan_omni_request('GET', f'/cloud/pay/{command_id}/status')

    def aslan_cash_device_capabilities(self):
        """Ask the API whether this merchant has an online recycler paired.
        Returns {'hasRecycler': bool} on success, or the usual error envelope.

        Called on POS session start to decide whether to show the cash method."""
        self.ensure_one()
        device_id = self.sudo().aslan_omni_device_id
        if not device_id:
            return {'error': 'not_configured'}
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(device_id)):
            return {'error': 'not_configured'}
        return self._aslan_omni_request('GET', f'/cloud/devices/{device_id}/capabilities')

    def _aslan_omni_request(self, method, path, payload=None):
        """Call the Omni API with the merchant key, which never leaves the server.

        Returns {'httpStatus': int, 'body': dict}, or {'error': 'not_configured' | 'api_unreachable'}.
        ('api_unreachable' = this server could not reach the API; the POS client
        reports its own failure to reach this server as 'network'.)
        """
        self.ensure_one()
        if not self.env.su and not self.env.user.has_group('point_of_sale.group_pos_user'):
            raise AccessDenied()
        self.check_access('read')  # record rules (e.g. multi-company) before going sudo
        method_sudo = self.sudo()
        if method_sudo.payment_provider not in ('aslan_omni', 'aslan_cash') \
                or not method_sudo.aslan_omni_api_key \
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
            return {'error': 'api_unreachable'}
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
