{
    'name': 'Aslan Omni Payment',
    'version': '20.0.1.0.0',
    'category': 'Sales/Point of Sale',
    'summary': 'Aslan Omni card terminal integration for Odoo POS',
    'author': 'Aslan',
    'depends': ['point_of_sale'],
    'data': [
        'views/pos_payment_method_views.xml',
        'receipt/pos_order_receipt.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'aslan_omni_payment/static/src/app/**/*',
            'aslan_omni_payment/static/src/overrides/**/*',
        ],
        'point_of_sale.payment_terminals': [
            'aslan_omni_payment/static/src/app/payment_aslan_omni.js',
            'aslan_omni_payment/static/src/overrides/models/pos_payment.js',
        ],
        'web.assets_backend': [
            'aslan_omni_payment/static/src/backend/aslan_omni_pairing_widget/*',
        ],
    },
    'installable': True,
    'auto_install': False,
    'license': 'LGPL-3',
}
