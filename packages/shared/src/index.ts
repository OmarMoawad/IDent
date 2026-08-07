export type HealthStatus = {
  status: "ok" | "degraded";
  timestamp: string;
  db: "ok" | "unreachable";
};
