import { AlertChannel, AlertOperator } from './enums';

export interface MetricsResponse {
  serverId: string;
  cpu: MetricPoint[];
  memory: MetricPoint[];
  disk: MetricPoint[];
  network: NetworkMetricPoint[];
}

export interface MetricPoint {
  value: number;
  timestamp: string;
}

export interface NetworkMetricPoint {
  bytesIn: number;
  bytesOut: number;
  timestamp: string;
}

export interface CreateAlertRuleRequest {
  name: string;
  serverId: string;
  metric: 'cpu' | 'memory' | 'disk';
  threshold: number;
  operator?: `${AlertOperator}`;
  channel: AlertChannel;
  webhookUrl?: string;
}

export interface AlertRuleResponse {
  id: string;
  name: string;
  serverId: string;
  metric: string;
  threshold: number;
  /** Comparison operator (schema default GTE). */
  operator: `${AlertOperator}`;
  channel: AlertChannel;
  webhookUrl: string | null;
  enabled: boolean;
  createdAt: string;
}
