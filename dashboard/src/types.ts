export interface StatsResponse {
  deliveries: Record<string, number>;
  queues: Record<string, Record<string, number>>;
  oldest_pending_age_s: number | null;
  backpressure_active: boolean;
}

export interface DeliveryListItem {
  id: string;
  event_id: string;
  endpoint_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryListResponse {
  data: DeliveryListItem[];
  next_cursor: string | null;
}

export interface AttemptDetail {
  attempt_number: number;
  outcome: string;
  http_status: number | null;
  response_body: string | null;
  error_message: string | null;
  latency_ms: number;
  started_at: string;
  finished_at: string;
}

export interface TransitionDetail {
  from_status: string | null;
  to_status: string;
  actor: string;
  reason: string | null;
  created_at: string;
}

export interface DeliveryDetail extends DeliveryListItem {
  event: { id: string; event_type: string; payload: unknown; received_at: string };
  endpoint: { id: string; url: string };
  attempts: AttemptDetail[];
  transitions: TransitionDetail[];
}

export interface DlqItem extends DeliveryListItem {
  dlq_entered_at: string;
}

export interface DlqResponse {
  data: DlqItem[];
  next_cursor: string | null;
}

export interface Endpoint {
  id: string;
  client_id: string;
  url: string;
  is_active: boolean;
}

export interface Filters {
  statuses: string[];
  endpoint_id: string;
  from: string;
  to: string;
}
