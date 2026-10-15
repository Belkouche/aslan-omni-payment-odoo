{
    'name': 'Aslan Omni Payment',
    'version': '20.0.1.0.0',
    'category': 'Point of Sale',
    'summary': 'Aslan Omni card terminal integration for Odoo POS',
    'author': 'Aslan',
    'depends': ['point_of_sale'],
    'data': [
        'data/payment_method.xml',
        'views/pos_config_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'aslan_omni_payment/static/src/js/AslanOmniPaymentInterface.js',
            'aslan_omni_payment/static/src/js/AslanOmniPairingWidget.js',
            'aslan_omni_payment/static/src/js/AslanOmniReceiptLine.js',
            'aslan_omni_payment/static/src/xml/AslanOmniPaymentScreen.xml',
            'aslan_omni_payment/static/src/xml/AslanOmniPairingWidget.xml',
            'aslan_omni_payment/static/src/xml/AslanOmniReceiptLine.xml',
        ],
    },
    'installable': True,
    'auto_install': False,
    'license': 'LGPL-3',
}
