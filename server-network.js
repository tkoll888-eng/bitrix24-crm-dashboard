export function listenerHost(allowPersonalFallback) {
  return allowPersonalFallback === true ? "127.0.0.1" : undefined;
}
