# Aslan Omni Payment — Odoo POS integration

An **Odoo 15 Point of Sale** add-on that turns an **Aslan Omni card terminal**
into a payment method inside Odoo. When a cashier rings up an order and chooses
"Aslan Omni", Odoo tells the terminal (over the Aslan cloud) how much to charge;
the customer taps or inserts their card on the terminal; the result (approved /
declined) flows back into Odoo and onto the receipt.

If you have never touched this code before, read this file top to bottom — it
explains not just *how* to use it, but *why* it is built the way it is,
especially around the parts that handle money.

---

## Table of contents

1. [The one-paragraph mental model](#1-the-one-paragraph-mental-model)
2. [Who talks to whom (architecture)](#2-who-talks-to-whom-architecture)
3. [What a payment actually looks like, step by step](#3-what-a-payment-actually-looks-like-step-by-step)
4. [Installation](#4-installation)
5. [Pairing a terminal (one-time setup per till)](#5-pairing-a-terminal-one-time-setup-per-till)
6. [Taking a payment (the cashier's view)](#6-taking-a-payment-the-cashiers-view)
7. [Reversing (voiding) a payment](#7-reversing-voiding-a-payment)
8. [The money-safety rules (READ THIS before editing payment code)](#8-the-money-safety-rules-read-this-before-editing-payment-code)
9. [The files, one by one](#9-the-files-one-by-one)
10. [The server API this add-on calls](#10-the-server-api-this-add-on-calls)
11. [Security model](#11-security-model)
12. [Troubleshooting](#12-troubleshooting)
13. [Known limitations](#13-known-limitations)
14. [Glossary](#14-glossary)

---

## 1. The one-paragraph mental model

Odoo POS runs **in the cashier's browser**. The Omni terminal is a **separate
physical device** that may be across the counter or in another room. They never
talk directly. Instead, Odoo sends an HTTPS request to the **Aslan Omni cloud
API**, and the cloud **relays** the command to the terminal over a live
connection (Server-Sent Events). The terminal reads the card, then posts the
result back up to the cloud, which hands it back to the waiting Odoo request.
Everything in this add-on is a thin client around four cloud endpoints:
**pair**, **pay**, **reverse**, and **revoke**.

---

## 2. Who talks to whom (architecture)

```
┌───────────────────────┐        HTTPS         ┌────────────────────────┐      SSE relay      ┌──────────────────┐
│  Odoo POS (browser)   │  ───────────────────▶│   Aslan Omni API       │ ──────────────────▶ │  Omni terminal   │
│  = this add-on        │   POST /cloud/pay    │   (cloud relay)        │   "PayCommand"      │  (Sunmi device)  │
│                       │◀──────────────────── │                        │ ◀────────────────── │                  │
│  - pairing widget     │   final result       │  - holds the request   │   card result       │  - reads card    │
│  - payment interface  │   (long-poll ≤95 s)  │    open up to 95 s     │                     │  - NapsPay auth  │
│  - receipt block      │                      │  - stores command by   │                     │                  │
└───────────────────────┘                      │    `ref` (idempotent)  │                     └──────────────────┘
                                                └────────────────────────┘
```

Key facts that shape everything else:

- **Odoo → cloud is a normal HTTPS request.** But it is a *long-poll*: the
  server does not answer immediately. It holds the connection open for up to
  **95 seconds** while the customer fumbles for their card, then answers with
  the final result. (This is why the client timeout is 97 s — a 2-second buffer
  over the server's 95 s.)
- **Cloud → terminal is a live push (SSE).** The terminal keeps a streaming
  connection open to the cloud; the cloud pushes it a `PayCommand`. This add-on
  never talks to the terminal directly, so it does not need to be on the same
  Wi-Fi as the terminal.
- **The terminal, not Odoo, owns the card interaction.** Once the command is
  sent, only the terminal (or its 95 s timeout) can finish or abort it. Odoo is
  a bystander waiting for the answer. This single fact is why cancellation and
  retries work the way they do — see [section 8](#8-the-money-safety-rules-read-this-before-editing-payment-code).

---

## 3. What a payment actually looks like, step by step

The happy path and the three failure paths, drawn out:

### Happy path

```
Cashier clicks "Charge"
   │
   ▼
Odoo POST /cloud/pay  { ref, amountCents, ... }     ◀── ref = "ODOO-<order.uid>-<line.cid>"  (STABLE, see §8)
   │                                                      amountCents = line amount × 100
   ▼
Cloud stores the command keyed by `ref`, pushes "PayCommand" to the terminal,
and HOLDS the HTTP response open (long-poll).
   │
   ▼
Customer taps card → terminal authorises via NapsPay → terminal POSTs result to cloud
   │
   ▼
Cloud answers the still-open Odoo request with { status: "approved", cardScheme, authNumber, stan, rrn, ... }
   │
   ▼
Odoo: payment line → "done", stores masked card details for the receipt.  ✅
```

### Failure path A — terminal not connected

The cloud answers `503` immediately. Odoo shows *"Terminal non connecté"* and
lets the cashier retry. No card was read, no money moved.

### Failure path B — customer never presents a card

After 95 s the cloud answers `408 { status: "timeout" }`. Odoo shows *"Délai
expiré"*. No money moved.

### Failure path C — the internet drops mid-payment (the important one)

This is where the design earns its keep. The Odoo request dies with a network
error — but the terminal may still be reading the card, and the cloud may have
already recorded (or completed) the command. The add-on does **not** give up. It
**re-POSTs `/cloud/pay` with the exact same `ref`**, up to a few times. Because
the ref is stable, the server recognises it and:

- if the command already **completed** → returns the real result (we show
  approved/declined — correct, no double charge);
- if it is still **pending** → returns `409 + commandId`, and we switch to
  polling `/cloud/pay/:commandId/status` until it resolves;
- if a prior attempt **timed out** → the server safely re-relays the same ref.

In every branch the customer's card is charged **at most once**. See
[section 8](#8-the-money-safety-rules-read-this-before-editing-payment-code) for
why the stable ref is load-bearing here.

---

## 4. Installation

**Prerequisites:** Odoo 15, the `point_of_sale` module, and an Aslan Omni
terminal that can reach the cloud API.

1. Copy this folder into your Odoo add-ons path, named exactly
   **`aslan_omni_payment`** (the folder name is the technical module name that
   every asset path and the payment-method key depend on):

   ```
   <your-addons-path>/aslan_omni_payment/
   ```

2. Restart Odoo and update the apps list (Settings → *Activate developer mode* →
   Apps → *Update Apps List*).

3. Install **"Aslan Omni Payment"** from the Apps menu.

That creates a payment method named **"Aslan Omni"** (see
`data/payment_method.xml`) and adds an **Aslan Omni** section to each Point of
Sale's settings form.

> **Module name matters.** The manifest wires assets under
> `aslan_omni_payment/static/...` and registers the payment interface under the
> key `aslan_omni`. If you rename the folder, those paths break. Keep it
> `aslan_omni_payment`.

---

## 5. Pairing a terminal (one-time setup per till)

Pairing exchanges a short code shown on the terminal for a **merchant API key**
that Odoo stores and sends on every future request. You do this once per Point
of Sale.

1. In Odoo: **Point of Sale → Configuration → Point of Sale**, open the till you
   want to pair. Scroll to the **Aslan Omni** section.
2. Confirm the **Aslan API URL** (defaults to `https://api.aslanpay.ma`). It
   **must** be `https://` — the add-on refuses anything else (credentials travel
   on this URL).
3. On the **terminal**, start pairing ("Associer avec Odoo"). It shows an
   **8-character code** (valid for 120 seconds).
4. Type that code into the pairing widget in Odoo and click **Associer**.
5. On success the widget shows ✅ *Terminal associé* with the Device ID, and Odoo
   has silently stored the **Device ID** and the **API Key**.

Under the hood: the widget calls `POST /cloud/pair { pairingCode }`; the server
returns `{ deviceId, apiKey, merchantId, merchantName }`; the widget writes
`aslan_omni_device_id` and `aslan_omni_api_key` onto the `pos.config` record.

**Re-associate / Dissociate.** The ✅ panel offers both. *Dissocier* calls
`POST /cloud/devices/:deviceId/revoke` (best effort) and **always** clears the
local key and device id afterwards, even if that network call fails — so a
revoke can never leave a dead key behind in Odoo.

---

## 6. Taking a payment (the cashier's view)

1. Build the order in POS as usual.
2. At payment, choose **Aslan Omni** and click **Charge** (or enter a partial
   amount first — the terminal is told exactly the line amount).
3. Odoo shows *"waiting for card"*; the terminal lights up and asks for the card.
4. The customer taps / inserts / swipes. On approval the line turns green and the
   card details (scheme, masked number, auth, RRN) print on the receipt.

If the cashier clicks **Cancel** while waiting: read
[section 8.3](#83-cancel-does-not-stop-the-terminal) — this is a POS-UI reset
only; it does **not** stop the terminal.

---

## 7. Reversing (voiding) a payment

From a paid order, Odoo's **Reverse** action calls `sendReversal`, which issues
`POST /cloud/reverse`. A reversal needs the original transaction's **STAN**
(System Trace Audit Number), which was saved on the payment line at approval
time. If the STAN is missing, the reversal is refused with a clear message
rather than sending a malformed void.

Like a payment, a reversal is a relayed long-poll command, and its own `ref`
(`REV-<original-ref>`) is **stable**, so a dropped reversal can be retried safely
without issuing a second void.

---

## 8. The money-safety rules (READ THIS before editing payment code)

Three rules keep this integration from double-charging. They are subtle, and the
code enforces them in ways that look optional but are not. If you change the
payment flow, keep all three true.

### 8.1 The `ref` is a STABLE idempotency key — never put a timestamp in it

The server keys its **entire** deduplication and recovery logic on `ref`
(`omniPendingCommand.ref` is a unique column). Re-sending the **same** ref is how
the server knows "this is the same payment, don't start a second card read — give
me back the existing result."

This add-on builds the ref in **one** place, `_payRef()`:

```js
_payRef(order, paymentLine) {
    return `ODOO-${order.uid}-${paymentLine.cid}`;   // order id + stable per-line id
}
```

`paymentLine.cid` is Odoo's stable client id for that payment line — it does not
change between retries. So one physical payment line always maps to exactly one
ref.

> ⚠️ **The original bug this replaced:** the ref used to be
> `ODOO-${order.uid}-${Date.now()}`. Because `Date.now()` changes on every
> attempt, every retry produced a *new* ref → a *new* server command → the
> server's dedup could not link them → a retry after a lost response could read
> a **second** card and charge twice. Never reintroduce a changing value here.

### 8.2 On any failure before a known result, RE-POST the same ref — do not give up

When the network drops mid-payment, we do **not** know whether the charge
happened. The only safe move is to ask the server, and the server's answer to
"re-POST the same ref" is exactly the recovery we need (completed → result,
pending → 409+poll, timed-out → re-relay). The payment loop does this
automatically, bounded by `MAX_RECOVERY_ATTEMPTS`.

> ⚠️ **The original bug this replaced:** the old code only polled if it *already*
> had a `commandId`, which it only learned *after* the first response parsed. A
> drop *during* the initial long-poll (the most common failure) left
> `commandId === null`, so it gave up — blind to a charge that may have
> succeeded. The re-POST-same-ref approach does not depend on having a commandId.

### 8.3 Cancel does NOT stop the terminal

There is **no server-side abort endpoint.** Once `/cloud/pay` has relayed the
command, only the terminal (its back button, or its own timeout) can stop the
card read. `sendPaymentCancel` therefore resets the Odoo UI **and warns the
cashier** to also cancel on the terminal if it is still asking for a card.

This is safe against double-charging **only because of rule 8.1**: if the cashier
re-charges the same line after a cosmetic cancel, the stable ref makes the server
re-attach to the existing command instead of starting a new card read. Removing
the stable ref would silently reopen this hole. (A true remote-abort would
require a new terminal-protocol message in `aslan-omni-api`; it does not exist
yet — see [Known limitations](#13-known-limitations).)

---

## 9. The files, one by one

| File | What it does |
|------|--------------|
| `__manifest__.py` | Odoo module descriptor. Declares the dependency on `point_of_sale`, loads the XML data/views, and registers the six front-end assets (3 JS + 3 QWeb templates) into the POS asset bundle. Version `15.0.1.0.0`, LGPL-3. |
| `data/payment_method.xml` | Creates the `pos.payment.method` record named "Aslan Omni" (`noupdate="1"` so admins can edit it without it being reset on upgrade). |
| `views/pos_config_views.xml` | Adds the **Aslan Omni** settings block to the Point of Sale configuration form: API URL field, read-only Device ID and API Key, and the pairing widget mount point. |
| `models/pos_config.py` | Extends `pos.config` with `aslan_omni_device_id`, `aslan_omni_api_key` (group-restricted — see §11), and `aslan_omni_api_url` (with an HTTPS-only `@api.constrains`). `aslan_omni_pair_widget` is a non-stored dummy field that exists only as a mount point for the Owl pairing widget. |
| `static/src/js/AslanOmniPaymentInterface.js` | **The core.** Subclass of Odoo's `AbstractPaymentInterface`. Implements `sendPaymentRequest` (pay + recovery loop), `sendPaymentCancel` (UI-only reset + warning), `sendReversal` (void), `_pollForResult` (fallback polling), result handling, and defensive PAN masking. Registered under the key `aslan_omni`. |
| `static/src/js/AslanOmniPairingWidget.js` | Owl component for the settings form: enter the 8-char code, call `/cloud/pair`, store the returned key/device id, and re-pair / revoke. |
| `static/src/js/AslanOmniReceiptLine.js` | Tiny Owl component that renders the card-details block on the receipt. |
| `static/src/xml/AslanOmniPairingWidget.xml` | QWeb template for the pairing widget's idle / loading / done / error / revoking states. |
| `static/src/xml/AslanOmniReceiptLine.xml` | QWeb template that appends the "PAIEMENT PAR CARTE" block to the POS receipt for Aslan Omni lines. |
| `static/src/xml/AslanOmniPaymentScreen.xml` | Intentionally empty — the default POS payment screen is used as-is. |

---

## 10. The server API this add-on calls

All endpoints live in `aslan-omni-api` (`src/routes/cloud.ts`), under the
`/cloud` prefix. Auth is a **merchant** bearer token (the API key from pairing)
unless noted.

| Method & path | Called by | Auth | Purpose |
|---------------|-----------|------|---------|
| `POST /cloud/pair` | pairing widget | none (code is the secret) | Exchange the 8-char pairing code for `{ deviceId, apiKey }`. Rate-limited (10/min/IP). Code TTL 120 s. |
| `POST /cloud/pay` | payment interface | `Bearer <apiKey>` | Start a payment. Long-polls up to **95 s**. Keyed on `ref` for idempotency. Returns the final result, `409 + commandId` if the ref is already running, `503` if the terminal is offline, or `408` on timeout. |
| `GET /cloud/pay/:commandId/status` | payment interface (fallback) | `Bearer <apiKey>` | Poll a command's status when we have its `commandId` (e.g. after a 409). Returns `{ status: pending\|completed\|timeout, resultStatus, ... }`. |
| `POST /cloud/reverse` | payment interface | `Bearer <apiKey>` + `X-Device-Id` | Void a prior approved payment using its `stan`. Same long-poll + idempotent-ref model as pay. |
| `POST /cloud/devices/:deviceId/revoke` | pairing widget | `Bearer <apiKey>` | Revoke this device's pairing (clears its server-side key). |

**Why the client timeout is 97 s:** the server holds `/cloud/pay` and
`/cloud/reverse` open for `COMMAND_TTL_MS = 95_000`. The client uses `97000` so
it never times out *before* the server has had its full window to answer.

---

## 11. Security model

- **HTTPS is mandatory.** Enforced in three places: the model constraint on
  `aslan_omni_api_url`, the pairing widget, and the payment interface. A non-TLS
  URL is rejected before any credential is sent.
- **The API key is a secret, scoped to managers.** `aslan_omni_api_key` carries
  `groups='point_of_sale.group_pos_manager,base.group_system'`, so ordinary
  cashiers cannot read the bearer token even though they use the terminal. It is
  also rendered with `password="True"` in the form.
- **Card numbers are never stored in full.** The terminal/cloud already mask the
  PAN, and the client masks again defensively (`_maskPan` keeps only the last 4
  digits) before anything is stored on the payment line or printed. No full PAN
  ever reaches Odoo's database or the receipt — consistent with SAQ-A scope.
- **No card data flows through Odoo.** The card is read on the terminal; Odoo
  only ever sees the *result* (approved/declined + masked metadata).

---

## 12. Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| *"Terminal Aslan Omni non configuré"* when charging | The till has no stored API key / device id | Pair the terminal (section 5). |
| *"Terminal non connecté"* (503) | The terminal has no live cloud connection | Check the terminal is powered on and online; retry. |
| *"Délai expiré"* (408) | Customer never presented a card within 95 s | Retry — nothing was charged. |
| *"Aslan Omni API URL must use HTTPS"* | The configured URL is `http://` or malformed | Fix the **Aslan API URL** to an `https://` endpoint. |
| Pairing fails with *"Pairing code not found or expired"* | The 8-char code expired (120 s) or was mistyped | Generate a fresh code on the terminal and re-enter promptly. |
| *"Impossible d'annuler : STAN absent"* on reverse | The payment line has no stored STAN | Only approved Aslan Omni payments carry a STAN; you cannot reverse a line that was never approved through this flow. |
| Network dropped mid-payment, cashier unsure if it charged | Covered by the recovery loop (§8.2) | Re-click **Charge** on the *same* line — the stable ref prevents a double charge; the server returns the real result. |

For deeper debugging, open the browser console: all failures surface through
`_showError`, and the network tab shows the exact `/cloud/*` request/response.

---

## 13. Known limitations

- **No true remote cancel.** Cancelling in Odoo is a UI reset only; the terminal
  must be cancelled on the terminal. A real abort needs a new terminal-protocol
  message in `aslan-omni-api` (an SSE "AbortCommand" + a `/cloud/pay/:id/cancel`
  endpoint). Until that exists, rely on the stable-ref safety net (§8.3).
- **Odoo 15 only.** The asset bundle keys (`point_of_sale.assets`) and the
  `AbstractPaymentInterface` import path are 15.x-specific. A 16/17 port needs
  the updated POS payment-terminal API.
- **No automated tests.** The payment state machine (pay / recover / reverse) is
  exactly the kind of logic that benefits from QUnit tests; none ship today.
  Until they do, test changes manually against a terminal or an emulator.

---

## 14. Glossary

| Term | Meaning |
|------|---------|
| **`ref`** | The idempotency key for one payment or reversal. Stable per payment line; the server dedups on it. |
| **`commandId`** | The server's internal id for a relayed command. Used to poll a command's status. |
| **STAN** | System Trace Audit Number — a per-transaction id from the card network, required to reverse a payment. |
| **RRN** | Retrieval Reference Number — another card-network transaction identifier printed on the receipt. |
| **SSE** | Server-Sent Events — the one-way live push the cloud uses to reach the terminal. |
| **Long-poll** | An HTTP request the server deliberately holds open (here up to 95 s) until it has an answer. |
| **COF / NapsPay** | The terminal's card-acquiring stack; this add-on only sees its results, never its internals. |
| **`pos.config`** | The Odoo model for one Point of Sale (one till); this is where the Omni credentials live. |

---

*Part of the Aslan payment platform. Terminal-side firmware and the cloud relay
live in `aslan-omni` and `aslan-omni-api` respectively.*
