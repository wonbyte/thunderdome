// The PlayQuota Durable Object: the public /play daily quota, kept in one instance.

import { DurableObject } from "cloudflare:workers";

import { quotaView, takeQuota, type QuotaState, type QuotaTaken, type QuotaView } from "./play";

const QUOTA_KEY = "quota";

/** One instance, "daily": the public /play quota. The per-IP counts never leave this object. */
export class PlayQuota extends DurableObject<Env> {
  /** Takes one play for ip on day. The state is saved only when the play is taken. */
  take(day: string, ip: string, daily: number): QuotaTaken {
    const result = takeQuota(this.#state(), day, ip, daily);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.ctx.storage.kv.put(QUOTA_KEY, result.state);
    return { ok: true, remaining: result.remaining };
  }

  /** Today's quota without the per-IP counts. */
  view(day: string, daily: number): QuotaView {
    return quotaView(this.#state(), day, daily);
  }

  #state(): QuotaState | undefined {
    return this.ctx.storage.kv.get<QuotaState>(QUOTA_KEY);
  }
}
