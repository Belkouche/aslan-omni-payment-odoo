/** @odoo-module **/

import { Component } from '@odoo/owl';
import { registry } from '@web/core/registry';

export class AslanOmniReceiptCardBlock extends Component {}
AslanOmniReceiptCardBlock.template = 'aslan_omni.ReceiptCardBlock';
AslanOmniReceiptCardBlock.props = {
    cardScheme:  { type: String, optional: true },
    cardNumber:  { type: String, optional: true },
    authNumber:  { type: String, optional: true },
    rrn:         { type: String, optional: true },
};

registry.category('components').add('AslanOmniReceiptCardBlock', AslanOmniReceiptCardBlock);
