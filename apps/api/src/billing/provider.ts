import type { Config } from '../config.ts';
import { safeEqual } from '../security.ts';
import { HttpError } from '../http.ts';
import { createHmac } from 'node:crypto';

/**
 * Austauschbare Zahlungsschnittstelle.
 * Ein Adapter für Stripe oder Paddle implementiert diese drei Methoden; der Rest der API bleibt gleich.
 *
 * Ablauf:
 * 1. App ruft POST /v1/billing/checkout → Bestellung wird angelegt, Adapter liefert eine Bezahl-URL.
 * 2. Nutzer bezahlt beim Anbieter.
 * 3. Anbieter ruft POST /v1/billing/webhook/:provider → Adapter prüft die Signatur und meldet die bezahlte Bestellung.
 * 4. ToyPost schaltet den Tarif frei oder schreibt die Credits gut (idempotent).
 */

export interface CheckoutOrder {
  id: string;
  description: string;
  amountCents: number;
  type: 'plan' | 'credits';
  /** bei Abos: monatlich oder jährlich wiederkehrend */
  interval?: 'month' | 'year';
}

export interface CheckoutCustomer {
  accountId: string;
  email: string;
  name: string;
}

export interface WebhookEvent {
  orderId: string;
  status: 'paid' | 'failed';
  providerRef?: string;
}

export interface PaymentProvider {
  readonly id: string;
  createCheckout(order: CheckoutOrder, customer: CheckoutCustomer): Promise<{ url: string; providerRef: string }>;
  /** null, wenn die Signatur nicht stimmt oder das Ereignis irrelevant ist */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
}

/**
 * Entwicklungs-Anbieter: Die "Bezahl-URL" zeigt auf die API selbst und bestätigt die Zahlung sofort.
 * In Produktion abgeschaltet.
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly id = 'dev';
  private readonly publicUrl: string;
  private readonly secret: string;

  constructor(publicUrl: string, secret: string) {
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.secret = secret;
  }

  sign(orderId: string): string {
    return createHmac('sha256', this.secret).update(`dev-pay:${orderId}`).digest('hex').slice(0, 32);
  }

  async createCheckout(order: CheckoutOrder): Promise<{ url: string; providerRef: string }> {
    return { url: `${this.publicUrl}/v1/billing/dev/pay/${order.id}?sig=${this.sign(order.id)}`, providerRef: `dev_${order.id}` };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const body = JSON.parse(rawBody || '{}') as { orderId?: string };
    const sig = String(headers['x-dev-signature'] ?? '');
    if (!body.orderId || !safeEqual(sig, this.sign(body.orderId))) return null;
    return { orderId: body.orderId, status: 'paid', providerRef: `dev_${body.orderId}` };
  }
}

/** Eigene Installation ohne Abrechnung: Kauf und Tarifwechsel sind abgeschaltet. */
export class NoPaymentProvider implements PaymentProvider {
  readonly id = 'none';
  async createCheckout(): Promise<{ url: string; providerRef: string }> {
    throw new HttpError(400, 'payments_disabled', 'In dieser Installation gibt es keine Bezahlung; alle Funktionen sind bereits freigeschaltet.');
  }
  parseWebhook(): WebhookEvent | null {
    return null;
  }
}

export function createPaymentProvider(config: Config): PaymentProvider {
  if (config.paymentProvider === 'none') return new NoPaymentProvider();
  if (config.paymentProvider === 'dev') {
    if (config.production) throw new Error('PAYMENT_PROVIDER=dev ist in Produktion nicht erlaubt.');
    return new DevPaymentProvider(config.publicUrl, config.secret);
  }
  throw new Error(
    `Zahlungsanbieter "${config.paymentProvider}" ist noch nicht angebunden. Lege einen Adapter in src/billing/ an (siehe provider.ts).`,
  );
}
