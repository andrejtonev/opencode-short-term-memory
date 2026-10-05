export function modelFreeLog(log: readonly { type: string }[]) {
  const permitted = new Set([
    "session.created",
    "session.viewed",
    "session.agent.selected",
    "session.model.selected",
    "log.synced",
  ]);
  return log.every((event) => permitted.has(event.type));
}

type SessionWitness = {
  id: string;
  projectID: string;
  title?: string;
  location: { directory: string };
  time: { created: number };
};
type ReplayItem = {
  type: string;
  aggregateID?: string;
  seq?: number;
  durable?: { aggregateID: string; seq: number };
  data?: { sessionID?: string };
};

export function validateLogBaseline(
  log: readonly ReplayItem[],
  created: SessionWitness,
  session: SessionWitness,
  directory: string,
) {
  if (
    !created.id ||
    session.id !== created.id ||
    !created.projectID ||
    session.projectID !== created.projectID ||
    created.location.directory !== directory ||
    session.location.directory !== directory ||
    session.title !== created.title ||
    !Number.isSafeInteger(created.time.created) ||
    created.time.created <= 0 ||
    session.time.created !== created.time.created
  )
    throw new Error("Session create/get catalog witness mismatch");

  const marker = log.at(-1);
  const sequenced = (seq: number | undefined): seq is number => Number.isSafeInteger(seq) && seq! >= 0;
  if (
    marker?.type !== "log.synced" ||
    marker.aggregateID !== created.id ||
    (marker.seq !== undefined && !sequenced(marker.seq))
  )
    throw new Error("Session log missing valid terminal replay witness");

  let previous = -1;
  for (const event of log.slice(0, -1)) {
    if (
      event.type === "log.synced" ||
      event.durable?.aggregateID !== created.id ||
      event.data?.sessionID !== created.id ||
      !sequenced(event.durable?.seq) ||
      event.durable.seq <= previous ||
      marker.seq === undefined ||
      event.durable.seq > marker.seq
    )
      throw new Error("Session log invalid aggregate or replay sequence");
    previous = event.durable.seq;
  }
  // Payload persistence is optional; sequence gaps and a marker-only replay are valid.
  if (!modelFreeLog(log)) throw new Error("Unexpected durable session activity (possible prompt/generation/synthetic)");
}
