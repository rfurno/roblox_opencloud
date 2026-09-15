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

export type SnapshotRequest = {
  universeId: string;
  apiKey: string;
};

export type SnapshotApiResult = {
  status: number;
  body: string;
  newSnapshotTaken: boolean | null;
  latestSnapshotTime: string | null;
};

export const COLLECTOR_NOTIFY_STORE = "CollectorNotify";

export type DataStoreEntryRef = {
  id: string;
  path: string;
};

export type ListEntriesResult = {
  status: number;
  body: string;
  entries: DataStoreEntryRef[];
  nextPageToken: string | null;
};

export type GetEntryResult = {
  status: number;
  body: string;
  value: unknown;
};

export function listDataStoreEntriesUrl(
  universeId: string,
  storeId = COLLECTOR_NOTIFY_STORE,
  pageToken?: string,
): string {
  const url = new URL(
    `https://apis.roblox.com/cloud/v2/universes/${universeId}/data-stores/${encodeURIComponent(storeId)}/entries`,
  );
  url.searchParams.set("maxPageSize", "256");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

export function dataStoreEntryUrl(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  return `https://apis.roblox.com/cloud/v2/${trimmed}`;
}

export function parseListedEntries(body: string): {
  entries: DataStoreEntryRef[];
  nextPageToken: string | null;
} {
  if (!body) return { entries: [], nextPageToken: null };
  try {
    const parsed = JSON.parse(body) as {
      dataStoreEntries?: unknown;
      nextPageToken?: unknown;
    };
    const raw = Array.isArray(parsed.dataStoreEntries) ? parsed.dataStoreEntries : [];
    const entries: DataStoreEntryRef[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as { id?: unknown; path?: unknown };
      const id = typeof rec.id === "string" ? rec.id : "";
      const path = typeof rec.path === "string" ? rec.path : "";
      if (!id && !path) continue;
      entries.push({
        id,
        path:
          path ||
          `universes/unknown/data-stores/${COLLECTOR_NOTIFY_STORE}/entries/${encodeURIComponent(id)}`,
      });
    }
    return {
      entries,
      nextPageToken: typeof parsed.nextPageToken === "string" && parsed.nextPageToken ? parsed.nextPageToken : null,
    };
  } catch {
    return { entries: [], nextPageToken: null };
  }
}

export function parseEntryValue(body: string): unknown {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { value?: unknown };
    return parsed.value ?? null;
  } catch {
    return null;
  }
}

export function readUpdatedUnix(value: unknown): number | null {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const n = Number((v as { updatedUnix?: unknown }).updatedUnix);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

export async function listDataStoreEntries(req: {
  universeId: string;
  apiKey: string;
  storeId?: string;
  pageToken?: string;
}): Promise<ListEntriesResult> {
  if (!req.apiKey) return { status: 0, body: "missing api key", entries: [], nextPageToken: null };
  const res = await fetch(listDataStoreEntriesUrl(req.universeId, req.storeId, req.pageToken), {
    headers: { "x-api-key": req.apiKey },
  });
  const body = await res.text();
  const parsed = parseListedEntries(body);
  return { status: res.status, body, ...parsed };
}

export async function getDataStoreEntry(req: {
  apiKey: string;
  path: string;
}): Promise<GetEntryResult> {
  if (!req.apiKey) return { status: 0, body: "missing api key", value: null };
  const res = await fetch(dataStoreEntryUrl(req.path), {
    headers: { "x-api-key": req.apiKey },
  });
  const body = await res.text();
  return { status: res.status, body, value: parseEntryValue(body) };
}

export function snapshotUrl(universeId: string): string {
  return `https://apis.roblox.com/cloud/v2/universes/${universeId}/data-stores:snapshot`;
}

export function parseSnapshotBody(body: string): {
  newSnapshotTaken: boolean | null;
  latestSnapshotTime: string | null;
} {
  if (!body) return { newSnapshotTaken: null, latestSnapshotTime: null };
  try {
    const parsed = JSON.parse(body) as {
      newSnapshotTaken?: unknown;
      latestSnapshotTime?: unknown;
    };
    return {
      newSnapshotTaken: typeof parsed.newSnapshotTaken === "boolean" ? parsed.newSnapshotTaken : null,
      latestSnapshotTime:
        typeof parsed.latestSnapshotTime === "string" ? parsed.latestSnapshotTime : null,
    };
  } catch {
    return { newSnapshotTaken: null, latestSnapshotTime: null };
  }
}

export async function snapshotDataStores(req: SnapshotRequest): Promise<SnapshotApiResult> {
  if (!req.apiKey) {
    return { status: 0, body: "missing api key", newSnapshotTaken: null, latestSnapshotTime: null };
  }
  if (!req.universeId) {
    return { status: 0, body: "missing universe id", newSnapshotTaken: null, latestSnapshotTime: null };
  }

  const res = await fetch(snapshotUrl(req.universeId), {
    method: "POST",
    headers: {
      "x-api-key": req.apiKey,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const body = await res.text();
  const parsed = parseSnapshotBody(body);
  return { status: res.status, body, ...parsed };
}
