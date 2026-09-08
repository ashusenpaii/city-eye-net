import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";

/** Twilio's shared WhatsApp sandbox sender, used until a verified business sender is set. */
const SANDBOX_SENDER = "+14155238886";

const AlertInput = z.object({
  to: z.string().min(8).max(20), // E.164, e.g. +919876543210
  body: z.string().min(1).max(1600),
});

function e164(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return `+${digits}`;
}

export const sendWhatsAppAlert = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => AlertInput.parse(input))
  .handler(async ({ data }) => {
    const lovableKey = process.env["LOVABLE_API_KEY"];
    const twilioKey = process.env["TWILIO_API_KEY"];
    if (!lovableKey || !twilioKey) {
      return {
        ok: false as const,
        status: 412,
        configured: false as const,
        error:
          "WhatsApp Business account is not connected yet. Connect Twilio WhatsApp in project settings to send from the server.",
      };
    }

    const from = process.env["TWILIO_WHATSAPP_FROM"] ?? SANDBOX_SENDER;

    const res = await fetch(`${GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": twilioKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: `whatsapp:${e164(data.to)}`,
        From: `whatsapp:${e164(from)}`,
        Body: data.body,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        message = parsed.message ?? message;
      } catch {
        /* keep raw text */
      }
      console.error(`Twilio WhatsApp send failed [${res.status}]: ${text}`);
      return { ok: false as const, status: res.status, configured: true as const, error: message };
    }

    let sid = "";
    try {
      sid = (JSON.parse(text) as { sid?: string }).sid ?? "";
    } catch {
      /* ignore */
    }
    return { ok: true as const, sid, from: e164(from) };
  });
