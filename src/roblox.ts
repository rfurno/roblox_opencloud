export type MomentRequest = {
  userId: number;
  universeId: string;
  apiKey: string;
  messageId: string;
  slotKey: string;
};

export type MomentResult = {
  status: number;
  body: string;
};

const ENDPOINT = "https://apis.roblox.com/cloud/v2/users";

export function notificationUrl(userId: number): string {
  return `${ENDPOINT}/${userId}/notifications`;
}

export function momentPayload(req: MomentRequest): unknown {
  return {
    source: { universe: `universes/${req.universeId}` },
    payload: {
      message_id: req.messageId,
      type: "MOMENT",
    },
    join_experience: {
      launch_data: `collector:${req.slotKey}`,
    },
    analytics_data: {
      category: "collector_incoming",
    },
  };
}

export async function sendMoment(req: MomentRequest): Promise<MomentResult> {
  if (!req.apiKey) {
    return { status: 0, body: "missing api key" };
  }
  if (!req.messageId || req.messageId.includes("xxxxxxxx")) {
    return { status: 0, body: "missing message_id" };
  }
  const expectedUniverse = `universes/${req.universeId}`;
  const payload = momentPayload(req) as { source: { universe: string } };
  if (payload.source.universe !== expectedUniverse) {
    return { status: 0, body: "universe mismatch" };
  }

  const res = await fetch(notificationUrl(req.userId), {
    method: "POST",
    headers: {
      "x-api-key": req.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { status: res.status, body };
}

export function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export function isNonRetryable(status: number): boolean {
  return status === 400 || status === 403 || status === 404;
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}
