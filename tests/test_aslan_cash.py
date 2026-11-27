"""Unit tests for the Aslan Cash (Cashmatic recycler) payment method.

Scope: the server-side model methods (`aslan_cash_*`) that the POS client
calls. These are the only pieces that run in Python — the full happy-path /
partial / cancel flows live in JS, which is QUnit territory, not covered here.

Tests patch out HTTP by replacing `_aslan_omni_request` on the model with a
stub, so we exercise argument shaping, path construction, and the capability
gate without network access.
"""
from unittest.mock import patch

from odoo.tests.common import TransactionCase


class TestAslanCashPaymentMethod(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        journal = cls.env['account.journal'].search([('type', '=', 'cash')], limit=1)
        if not journal:
            journal = cls.env['account.journal'].create({
                'name': 'Cash test',
                'type': 'cash',
                'code': 'TCSH',
            })
        cls.method = cls.env['pos.payment.method'].create({
            'name': 'Cashmatic test',
            # `type` is a required Selection on pos.payment.method with no
            # stored compute or default — core expects callers to set it at
            # create time (same shape as the core pos_cashmatic tests).
            'type': 'cash',
            'journal_id': journal.id,
            'payment_provider': 'aslan_cash',
            'aslan_omni_api_url': 'https://api.aslanpay.ma',
            'aslan_omni_device_id': 'DEV-TEST',
            'aslan_omni_api_key': 'secret_key_test',
            'aslan_cash_tips_enabled': True,
        })

    # --- aslan_cash_send_payment ---

    def test_send_payment_shapes_the_payload(self):
        captured = {}

        def stub(self, method, path, payload=None):
            captured.update(method=method, path=path, payload=payload)
            return {'httpStatus': 202, 'body': {'commandId': 'cmd_123'}}

        with patch.object(type(self.method), '_aslan_omni_request', stub):
            res = self.method.aslan_cash_send_payment(
                ref='ODOC-abc', amount_cents=4400,
                tips_amount_cents=200, cashier_id='7', till_id='1',
                description='ORDER/0001',
            )
        self.assertEqual(res['body']['commandId'], 'cmd_123')
        self.assertEqual(captured['method'], 'POST')
        self.assertEqual(captured['path'], '/cloud/pay')
        self.assertEqual(captured['payload']['method'], 'cash')
        self.assertEqual(captured['payload']['amountCents'], 4400)
        self.assertEqual(captured['payload']['tipsAmountCents'], 200)
        self.assertIs(captured['payload']['wait'], False)
        self.assertIs(captured['payload']['allowCustomerCancel'], True)

    def test_send_payment_omits_zero_tip_and_empty_fields(self):
        captured = {}

        def stub(self, method, path, payload=None):
            captured.update(payload=payload)
            return {'httpStatus': 202, 'body': {}}

        with patch.object(type(self.method), '_aslan_omni_request', stub):
            self.method.aslan_cash_send_payment(
                ref='ODOC-xyz', amount_cents=1000, tips_amount_cents=0,
            )
        # aslan_cash_send_payment emits None for zero-tip / unset fields and
        # relies on _aslan_omni_request's `{k: v for ... if v is not None}`
        # sanitiser to strip them before they reach the wire. The stub above
        # captures the payload BEFORE that sanitiser, so assert the pre-strip
        # contract: zero tip and unset optional fields produce None values,
        # not zeros or empty strings. If anything flipped to a falsy non-None
        # value (0, "", False) the sanitiser would forward it.
        p = captured['payload']
        self.assertIsNone(p.get('tipsAmountCents'))
        self.assertIsNone(p.get('cashierId'))
        self.assertIsNone(p.get('customDisplayMessage'))
        self.assertIsNone(p.get('tillId'))
        self.assertIsNone(p.get('description'))

    # --- aslan_cash_cancel ---

    def test_cancel_posts_to_the_right_path_and_passes_attempt(self):
        captured = {}

        def stub(self, method, path, payload=None):
            captured.update(method=method, path=path, payload=payload)
            return {'httpStatus': 202, 'body': {'ok': True}}

        with patch.object(type(self.method), '_aslan_omni_request', stub):
            self.method.aslan_cash_cancel('cmd_abc', attempt=2)
        self.assertEqual(captured['method'], 'POST')
        self.assertEqual(captured['path'], '/cloud/pay/cmd_abc/cancel')
        self.assertEqual(captured['payload'], {'attempt': 2})

    def test_cancel_refuses_an_unsafe_command_id(self):
        # The id is interpolated into a URL path, so anything that could change
        # the path (slashes, dots, spaces) is refused before any HTTP call.
        for bad in ('cmd/evil', '../../evil', 'abc def', '', None):
            res = self.method.aslan_cash_cancel(bad)
            self.assertEqual(res, {'error': 'invalid_command'},
                             f'expected refusal for {bad!r}')

    # --- aslan_cash_command_status ---

    def test_status_rejects_a_bad_command_id(self):
        res = self.method.aslan_cash_command_status('a b')
        self.assertEqual(res, {'error': 'invalid_command'})

    def test_status_builds_the_right_path(self):
        captured = {}

        def stub(self, method, path, payload=None):
            captured.update(method=method, path=path)
            return {'httpStatus': 200, 'body': {}}

        with patch.object(type(self.method), '_aslan_omni_request', stub):
            self.method.aslan_cash_command_status('cmd_xyz')
        self.assertEqual(captured['method'], 'GET')
        self.assertEqual(captured['path'], '/cloud/pay/cmd_xyz/status')

    # --- aslan_cash_device_capabilities ---

    def test_capabilities_returns_not_configured_without_device_id(self):
        self.method.aslan_omni_device_id = False
        res = self.method.aslan_cash_device_capabilities()
        self.assertEqual(res, {'error': 'not_configured'})

    def test_capabilities_queries_the_capability_endpoint(self):
        captured = {}

        def stub(self, method, path, payload=None):
            captured.update(method=method, path=path)
            return {'httpStatus': 200, 'body': {'hasRecycler': True}}

        with patch.object(type(self.method), '_aslan_omni_request', stub):
            res = self.method.aslan_cash_device_capabilities()
        self.assertEqual(captured['method'], 'GET')
        self.assertEqual(captured['path'], '/cloud/devices/DEV-TEST/capabilities')
        self.assertIs(res['body']['hasRecycler'], True)

    # --- shared _aslan_omni_request gating ---

    def test_request_refuses_when_provider_is_neither_card_nor_cash(self):
        self.method.payment_provider = False
        res = self.method._aslan_omni_request('GET', '/cloud/pay/x/status')
        self.assertEqual(res, {'error': 'not_configured'})

    def test_request_allows_both_card_and_cash_providers(self):
        """The cash provider must not be rejected by the request gate — this is
        the bug that would silently break every cash call."""
        captured = []

        def dummy_requests_request(method, url, **kwargs):
            captured.append((method, url))

            class _Resp:
                status_code = 200
                def json(self): return {'ok': True}
            return _Resp()

        with patch('requests.request', dummy_requests_request):
            for provider in ('aslan_omni', 'aslan_cash'):
                self.method.payment_provider = provider
                res = self.method._aslan_omni_request('GET', '/cloud/x')
                self.assertEqual(res['httpStatus'], 200,
                                 f'{provider}: should have made the request')
        self.assertEqual(len(captured), 2)


class TestAslanCredentialInheritance(TransactionCase):
    """When an operator adds a cash recycler payment method on a POS where the
    card method is already paired, the device_id/api_key must flow through —
    the help text promises "pair a terminal, not a specific payment method"."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.cash_journal = cls.env['account.journal'].search(
            [('type', '=', 'cash')], limit=1) or cls.env['account.journal'].create({
                'name': 'Cash inherit', 'type': 'cash', 'code': 'TCINH',
            })
        # Pick any POS config the base install exposes. We don't need a real
        # fully-wired POS — just a config row to hang both methods off of so
        # the `config_ids` link holds.
        cls.config = cls.env['pos.config'].search([], limit=1)
        if not cls.config:
            cls.config = cls.env['pos.config'].create({'name': 'Test POS inherit'})

    def _card(self, **over):
        vals = {
            'name': 'Card test',
            'type': 'bank',
            'journal_id': self.cash_journal.id,
            'payment_provider': 'aslan_omni',
            'aslan_omni_api_url': 'https://api.aslanpay.ma',
            'config_ids': [(6, 0, [self.config.id])],
        }
        vals.update(over)
        return self.env['pos.payment.method'].create(vals)

    def _cash(self, **over):
        vals = {
            'name': 'Cash test',
            'type': 'cash',
            'journal_id': self.cash_journal.id,
            'payment_provider': 'aslan_cash',
            'config_ids': [(6, 0, [self.config.id])],
        }
        vals.update(over)
        return self.env['pos.payment.method'].create(vals)

    def test_default_get_pulls_credentials_from_paired_card_sibling(self):
        self._card(aslan_omni_device_id='DEV-X', aslan_omni_api_key='key-X')
        values = self.env['pos.payment.method'].with_context(
            default_payment_provider='aslan_cash',
            default_config_ids=[(6, 0, [self.config.id])],
        ).default_get(['aslan_omni_device_id', 'aslan_omni_api_key', 'aslan_omni_api_url'])
        self.assertEqual(values.get('aslan_omni_device_id'), 'DEV-X')
        self.assertEqual(values.get('aslan_omni_api_key'), 'key-X')
        self.assertEqual(values.get('aslan_omni_api_url'), 'https://api.aslanpay.ma')

    def test_default_get_ignores_unpaired_card_sibling(self):
        # A card method with no device_id must not be picked up as a source.
        self._card()
        values = self.env['pos.payment.method'].with_context(
            default_payment_provider='aslan_cash',
            default_config_ids=[(6, 0, [self.config.id])],
        ).default_get(['aslan_omni_device_id', 'aslan_omni_api_key'])
        self.assertFalse(values.get('aslan_omni_device_id'))
        self.assertFalse(values.get('aslan_omni_api_key'))

    def test_default_get_skips_non_cash_drafts(self):
        self._card(aslan_omni_device_id='DEV-Y', aslan_omni_api_key='key-Y')
        # A draft with no provider or a different provider must not inherit.
        values = self.env['pos.payment.method'].default_get(
            ['aslan_omni_device_id', 'aslan_omni_api_key'])
        self.assertFalse(values.get('aslan_omni_device_id'))

    def test_write_on_card_propagates_to_blank_cash_sibling(self):
        card = self._card()
        cash = self._cash()
        self.assertFalse(cash.aslan_omni_device_id)
        card.write({'aslan_omni_device_id': 'DEV-W', 'aslan_omni_api_key': 'key-W'})
        cash.invalidate_recordset()
        self.assertEqual(cash.aslan_omni_device_id, 'DEV-W')
        self.assertEqual(cash.sudo().aslan_omni_api_key, 'key-W')

    def test_write_on_card_does_not_clobber_explicit_cash_device(self):
        card = self._card()
        cash = self._cash(
            aslan_omni_device_id='DEV-CASH-EXPLICIT',
            aslan_omni_api_key='key-cash-explicit',
        )
        card.write({'aslan_omni_device_id': 'DEV-W', 'aslan_omni_api_key': 'key-W'})
        cash.invalidate_recordset()
        self.assertEqual(cash.aslan_omni_device_id, 'DEV-CASH-EXPLICIT')
        self.assertEqual(cash.sudo().aslan_omni_api_key, 'key-cash-explicit')

    def test_write_on_cash_does_not_back_propagate_to_card(self):
        card = self._card(aslan_omni_device_id='DEV-CARD', aslan_omni_api_key='key-card')
        cash = self._cash()
        cash.write({'aslan_omni_device_id': 'DEV-CASH-NEW'})
        card.invalidate_recordset()
        # Card method keeps its own device id — cash writes never flow upward.
        self.assertEqual(card.aslan_omni_device_id, 'DEV-CARD')

    def test_write_skips_card_methods_with_no_config(self):
        """A card method not attached to any POS has no siblings to update —
        must not crash and must not try to query for siblings."""
        card = self._card(config_ids=[(5, 0)])
        card.write({'aslan_omni_device_id': 'DEV-ORPHAN'})
        self.assertEqual(card.aslan_omni_device_id, 'DEV-ORPHAN')
