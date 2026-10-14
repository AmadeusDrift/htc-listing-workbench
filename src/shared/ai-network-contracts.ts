export interface AiNetworkTargetResult {
  name: string; url: string; route: string; elapsedMs: number;
  state: 'HTTP_RESPONSE' | 'TIMEOUT' | 'NETWORK_ERROR' | 'PROXY_ERROR'; httpStatus?: number;
}
export interface AiNetworkReport { checkedAt: string; targets: AiNetworkTargetResult[] }
